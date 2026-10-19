import { realpathSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { fitToBudget } from '../budget.js';
import { dependencyGraph } from '../deps.js';
import { transformFile } from '../engine/transform.js';
import { changedFiles } from '../git.js';
import type { CommentMode } from '../languages/types.js';
import { render, type OutputFormat } from '../output/index.js';
import { FILE_ORDERS, orderFiles, type FileOrder } from '../order.js';
import { contentHash, documentFormat, DocumentError, parsePages, renderPdfPages, saveTranscripts, transcriptRoot } from '../documents/index.js';
import { readDocument, type ReadMode } from '../documents/read.js';
import { pack, readText } from '../pack.js';
import { computeStats, DEFAULT_MODELS, prefetchStats, TokenCounter } from '../tokens/index.js';
import { VERSION } from '../version.js';

/** MCP protocol revisions this server speaks (newest first). */
export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: string | number | null; result: unknown }
  | { jsonrpc: '2.0'; id: string | number | null; error: { code: number; message: string; data?: unknown } };

export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/** Thrown by tools for user-facing failures; reported as `isError` tool results. */
class ToolError extends Error {}

type ToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

interface ToolResult {
  content: ToolContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** The tool writes files (default: read-only). */
  writes?: boolean;
  run(args: Record<string, unknown>): Promise<ToolResult>;
}

const commentsSchema = { type: 'string', enum: ['all', 'docs', 'none'], description: 'Comments to keep outside focused files (default all).' };

function str(args: Record<string, unknown>, key: string, required = false): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) {
    if (required) throw new RpcError(ErrorCode.InvalidParams, `"${key}" is required`);
    return undefined;
  }
  if (typeof value !== 'string') throw new RpcError(ErrorCode.InvalidParams, `"${key}" must be a string`);
  return value;
}

function strList(args: Record<string, unknown>, key: string): string[] {
  const value = args[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    throw new RpcError(ErrorCode.InvalidParams, `"${key}" must be an array of strings`);
  }
  return value;
}

function num(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new RpcError(ErrorCode.InvalidParams, `"${key}" must be a positive number`);
  }
  return value;
}

function oneOf<T extends string>(args: Record<string, unknown>, key: string, allowed: readonly T[]): T | undefined {
  const value = str(args, key);
  if (value !== undefined && !allowed.includes(value as T)) {
    throw new RpcError(ErrorCode.InvalidParams, `"${key}" must be one of ${allowed.join(', ')}`);
  }
  return value as T | undefined;
}

export interface ServerOptions {
  /** Directories the tools may read. Paths outside them are rejected. */
  roots: readonly string[];
  /** Base for relative paths in tool arguments (default: the first root). */
  cwd?: string;
  log?: (message: string) => void;
}

/**
 * A Model Context Protocol server exposing astpack as tools. Transport-agnostic: feed it
 * parsed JSON-RPC messages with `handle`, or use `serveStdio`.
 */
export class AstpackMcpServer {
  private readonly roots: string[];
  private readonly cwd: string;
  private readonly tools: ToolDefinition[];
  private readonly log: (message: string) => void;

  constructor(options: ServerOptions) {
    // Compare real paths so a symlink inside a root cannot point the tools outside it.
    this.roots = options.roots.map((r) => {
      const abs = resolve(r);
      try {
        // Native realpath matches fs.promises.realpath (it also expands Windows 8.3 names).
        return realpathSync.native(abs);
      } catch {
        return abs;
      }
    });
    this.cwd = resolve(options.cwd ?? this.roots[0] ?? process.cwd());
    this.log = options.log ?? (() => {});
    this.tools = this.defineTools();
  }

  /** Handle one message. Returns the response, or `undefined` for notifications. */
  async handle(message: unknown): Promise<JsonRpcResponse | undefined> {
    if (typeof message !== 'object' || message === null || (message as JsonRpcRequest).jsonrpc !== '2.0') {
      return { jsonrpc: '2.0', id: null, error: { code: ErrorCode.InvalidRequest, message: 'Invalid JSON-RPC 2.0 message' } };
    }
    const request = message as JsonRpcRequest;
    const isNotification = request.id === undefined;
    if (typeof request.method !== 'string') {
      // A response from the client (we never send requests) or garbage.
      return isNotification ? undefined : { jsonrpc: '2.0', id: request.id ?? null, error: { code: ErrorCode.InvalidRequest, message: 'Missing method' } };
    }
    try {
      const result = await this.dispatch(request.method, request.params ?? {});
      return isNotification ? undefined : { jsonrpc: '2.0', id: request.id ?? null, result };
    } catch (error) {
      if (isNotification) return undefined;
      const code = error instanceof RpcError ? error.code : ErrorCode.InternalError;
      return { jsonrpc: '2.0', id: request.id ?? null, error: { code, message: (error as Error).message } };
    }
  }

  private async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'initialize': {
        const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
        const protocolVersion = (PROTOCOL_VERSIONS as readonly string[]).includes(requested) ? requested : PROTOCOL_VERSIONS[0];
        return {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'astpack', title: 'astpack', version: VERSION },
          instructions: SERVER_INSTRUCTIONS,
        };
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return undefined;
      case 'ping':
        return {};
      case 'tools/list':
        return {
          tools: this.tools.map(({ name, title, description, inputSchema, writes }) => ({
            name,
            title,
            description,
            inputSchema,
            annotations: { readOnlyHint: !writes, ...(writes ? { destructiveHint: false, idempotentHint: true } : {}), openWorldHint: false },
          })),
        };
      case 'tools/call': {
        const name = str(params, 'name', true)!;
        const tool = this.tools.find((t) => t.name === name);
        if (!tool) throw new RpcError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        if (typeof args !== 'object' || Array.isArray(args)) throw new RpcError(ErrorCode.InvalidParams, '"arguments" must be an object');
        try {
          return await tool.run(args);
        } catch (error) {
          if (error instanceof RpcError) throw error;
          this.log(`tool ${name} failed: ${(error as Error).stack ?? error}`);
          return { content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true } satisfies ToolResult;
        }
      }
      default:
        throw new RpcError(ErrorCode.MethodNotFound, `Method not found: ${method}`);
    }
  }

  /**
   * Resolve a tool path argument to its real path and make sure it stays inside an allowed
   * root (after following symlinks).
   */
  private async resolvePath(input: string): Promise<string> {
    const abs = isAbsolute(input) ? resolve(input) : resolve(this.cwd, input);
    let real: string;
    try {
      real = await realpath(abs);
    } catch {
      throw new ToolError(`${input} does not exist`);
    }
    const fold = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
    const allowed = this.roots.some((root) => {
      const rel = relative(fold(root), fold(real));
      return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
    });
    if (!allowed) throw new ToolError(`${input} is outside the allowed roots (${this.roots.join(', ')})`);
    return real;
  }

  /** The allowed root that contains `real` (a resolved path inside one). */
  private rootOf(real: string): string {
    const fold = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
    const inside = (root: string) => {
      const rel = relative(fold(root), fold(real));
      return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
    };
    // The deepest root wins when roots are nested.
    return this.roots.filter(inside).sort((a, b) => b.length - a.length)[0] ?? this.roots[0] ?? this.cwd;
  }

  /** Where a document's transcriptions go: its project folder, if that is inside the allowed roots. */
  private transcriptFolder(file: string): string {
    const root = this.rootOf(file);
    const project = transcriptRoot(file, root);
    const rel = relative(root, project);
    return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)) ? project : root;
  }

  private defineTools(): ToolDefinition[] {
    const packProperties = {
      path: { type: 'string', description: 'Project directory (absolute, or relative to the server root). Default: the server root.' },
      focus: {
        type: 'array',
        items: { type: 'string' },
        description: 'Files, directories or globs (relative to `path`) to include as full source.',
      },
      changed: { type: 'string', description: 'Also focus files changed vs this git ref (e.g. "HEAD" or "main").' },
      query: {
        type: 'string',
        description: 'Describe the task in words (e.g. "invoice pdf export"); the most relevant files are included in full.',
      },
      queryLimit: { type: 'number', description: 'Maximum number of files `query` includes in full (default 5).' },
      order: {
        type: 'string',
        enum: ['path', 'stable', 'size'],
        description: 'File order: path (default), stable (least recently changed first, keeps prompt-cache prefixes) or size.',
      },
      related: { type: 'number', description: 'Also include in full the files within this many import hops of a focused file (e.g. 1).' },
      mode: {
        type: 'string',
        enum: ['skeleton', 'full', 'outline'],
        description: 'skeleton (default) strips function bodies; full keeps them; outline lists declarations only.',
      },
      comments: commentsSchema,
      include: { type: 'array', items: { type: 'string' }, description: 'Only include files matching these gitignore-style patterns.' },
      ignore: { type: 'array', items: { type: 'string' }, description: 'Extra gitignore-style patterns to exclude.' },
      maxTokens: { type: 'number', description: 'Compress and omit files until the document fits this many tokens.' },
      documents: { type: 'boolean', description: 'Include documents (PDF, Office, EPUB, RTF, e-mail) converted to text (default true).' },
    };

    const runPack = async (args: Record<string, unknown>) => {
      // Validate every argument before touching the file system.
      const mode = oneOf(args, 'mode', ['skeleton', 'full', 'outline'] as const) ?? 'skeleton';
      const comments = oneOf<CommentMode>(args, 'comments', ['all', 'docs', 'none']);
      const focusArgs = strList(args, 'focus');
      const include = strList(args, 'include');
      const ignore = strList(args, 'ignore');
      const changed = str(args, 'changed');
      const query = str(args, 'query');
      const queryLimit = num(args, 'queryLimit');
      const order = oneOf<FileOrder>(args, 'order', FILE_ORDERS) ?? 'path';
      const depth = num(args, 'related');
      const related = depth === undefined ? undefined : Math.floor(depth);
      const root = await this.resolvePath(str(args, 'path') ?? '.');
      const info = await stat(root).catch(() => undefined);
      if (!info?.isDirectory()) throw new ToolError(`${root} is not a directory`);
      const focus = focusArgs.map((f) => (/[*?[\]{}]/.test(f) ? f : resolve(root, f)));
      if (changed) focus.push(...(await changedFiles(root, changed)));
      const documents = args.documents !== false;
      const packed = await pack(root, { mode, focus, related, query, queryLimit: queryLimit && Math.floor(queryLimit), cwd: root, comments, include, ignore, documents });
      return { root, result: await orderFiles(packed, order), comments };
    };

    return [
      {
        name: 'pack_codebase',
        title: 'Pack codebase',
        description:
          'The whole project in one document: directory tree plus every file, with function bodies replaced by ' +
          'placeholders (signatures, types, classes and comments kept), at a fraction of the tokens of reading the files. ' +
          'Use it to get oriented in a project before opening files one by one: mode "outline" is the most compact map. ' +
          'Files given in `focus`, matched by `query` or changed since `changed` stay verbatim. Respects .gitignore and ' +
          'skips dependencies, lockfiles, binaries and secrets.',
        inputSchema: {
          type: 'object',
          properties: {
            ...packProperties,
            format: { type: 'string', enum: ['markdown', 'xml', 'json'], description: 'Document format (default markdown).' },
            deps: { type: 'boolean', description: 'Include the internal import graph (which file imports which).' },
          },
          additionalProperties: false,
        },
        run: async (args) => {
          const format = oneOf<OutputFormat>(args, 'format', ['markdown', 'xml', 'json']) ?? 'markdown';
          const maxTokens = num(args, 'maxTokens');
          const deps = args.deps === true;
          const { root, result: packed, comments } = await runPack(args);
          const renderOptions = { projectName: basename(root), dependencies: deps ? (packed.dependencies ?? dependencyGraph(packed)) : undefined };
          let result = packed;
          let document: string;
          if (maxTokens) {
            const report = await fitToBudget(result, { maxTokens, render: (r) => render(format, r, renderOptions), comments });
            result = report.result;
            document = report.document;
          } else {
            document = render(format, result, renderOptions);
          }
          await prefetchStats(result, document);
          const stats = computeStats(result, document, { models: [...DEFAULT_MODELS] });
          return {
            content: [{ type: 'text', text: document }],
            // Some clients show the model only structuredContent: the document must be in it too.
            structuredContent: {
              files: stats.filesIncluded,
              tokens: stats.tokens.cl100k_base.output,
              rawTokens: stats.tokens.cl100k_base.baseline,
              savedPercent: Math.round(stats.savedRatio * 100),
              document,
            },
          };
        },
      },
      {
        name: 'estimate_tokens',
        title: 'Estimate tokens',
        description:
          'How many tokens pack_codebase would return for a project, how many the raw source would take, and the ' +
          'largest files, without the document itself. Cheap: use it on unfamiliar or large projects to choose mode, ' +
          'include and maxTokens.',
        inputSchema: {
          type: 'object',
          properties: { ...packProperties, top: { type: 'number', description: 'How many of the largest files to list (default 10).' } },
          additionalProperties: false,
        },
        run: async (args) => {
          const top = num(args, 'top') ?? 10;
          const maxTokens = num(args, 'maxTokens');
          const { root, result: packed, comments } = await runPack(args);
          const renderOptions = { projectName: basename(root) };
          let result = packed;
          let document: string;
          let budgetLine: string | undefined;
          if (maxTokens) {
            const report = await fitToBudget(result, { maxTokens, render: (r) => render('markdown', r, renderOptions), comments });
            result = report.result;
            document = report.document;
            const omitted = report.changes.filter((c) => c.to === 'omitted').length;
            budgetLine = `Budget ${maxTokens}: ${report.fits ? 'fits' : 'does not fit'} (${report.changes.length - omitted} files compressed, ${omitted} omitted)`;
          } else {
            document = render('markdown', result, renderOptions);
          }
          await prefetchStats(result, document);
          const stats = computeStats(result, document, { models: [...DEFAULT_MODELS] });
          const cl = stats.tokens.cl100k_base;
          const lines = [
            ...(budgetLine ? [budgetLine] : []),
            `Files: ${stats.filesIncluded} included, ${stats.entriesScanned - stats.filesIncluded} skipped`,
            `Tokens (cl100k_base): ${cl.output} packed, ${cl.baseline} raw (${Math.round(stats.savedRatio * 100)}% saved)`,
            `Tokens (o200k_base): ${stats.tokens.o200k_base.output} packed`,
            '',
            `Largest files (packed tokens / raw tokens):`,
            ...stats.files.slice(0, top).map((f) => `  ${f.path}: ${f.tokens} / ${f.originalTokens}${f.focused ? ' [focus]' : ''}`),
          ];
          return {
            content: [{ type: 'text', text: lines.join('\n') }],
            structuredContent: {
              files: stats.filesIncluded,
              tokens: cl.output,
              rawTokens: cl.baseline,
              savedPercent: Math.round(stats.savedRatio * 100),
              largest: stats.files.slice(0, top).map((f) => ({ path: f.path, tokens: f.tokens, rawTokens: f.originalTokens })),
              summary: lines.join('\n'),
            },
          };
        },
      },
      {
        name: 'skeleton_file',
        title: 'Skeleton of files',
        description:
          'One or more source files with function bodies stripped: imports, types, signatures and docs. Use it instead of ' +
          'reading a file when you need what it offers (its API, how to call it) rather than how it works inside.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path (absolute, or relative to the server root).' },
            paths: { type: 'array', items: { type: 'string' }, description: `Several file paths at once (at most ${MAX_SKELETON_FILES}).` },
            comments: commentsSchema,
          },
          additionalProperties: false,
        },
        run: async (args) => {
          const one = str(args, 'path');
          const many = strList(args, 'paths');
          const inputs = [...(one ? [one] : []), ...many];
          if (!inputs.length) throw new ToolError('Pass `path` or `paths`');
          if (inputs.length > MAX_SKELETON_FILES) throw new ToolError(`At most ${MAX_SKELETON_FILES} files per call`);
          const comments = oneOf<CommentMode>(args, 'comments', ['all', 'docs', 'none']);
          const counter = new TokenCounter();
          try {
            const files = [];
            for (const input of inputs) {
              const file = await this.resolvePath(input);
              const info = await stat(file).catch(() => undefined);
              if (!info?.isFile()) throw new ToolError(`${input} is not a file`);
              if (documentFormat(file, true)) {
                // A document: its condensed text (read_document reads it in full or by part).
                const read = await readDocument(file, { mode: 'skeleton', root: this.transcriptFolder(file) });
                const out = { content: read.text, strategy: read.view, language: { id: read.document.format } };
                files.push({ input, out, tokens: read.tokens, rawTokens: read.documentTokens });
                continue;
              }
              const content = await readText(file);
              const out = await transformFile(file, content, { mode: 'skeleton', comments, fallback: { maxLines: 400, maxChars: 40_000 } });
              files.push({ input, out, tokens: counter.count(out.content), rawTokens: counter.count(content) });
            }
            const text =
              files.length === 1
                ? files[0]!.out.content
                : files.map((f) => `### ${f.input}\n\n${f.out.content.replace(/\n?$/, '\n')}`).join('\n');
            const meta = files.map((f) => ({
              path: f.input,
              language: f.out.language?.id ?? null,
              strategy: f.out.strategy,
              tokens: f.tokens,
              rawTokens: f.rawTokens,
              // Some clients show the model only structuredContent: the skeleton must be in it too.
              skeleton: f.out.content,
            }));
            return {
              content: [{ type: 'text', text }],
              structuredContent: files.length === 1 ? meta[0] : { files: meta },
            };
          } finally {
            counter.free();
          }
        },
      },
      {
        name: 'read_document',
        title: 'Read document',
        description:
          'A document as Markdown: PDF, Word, PowerPoint, Excel, OpenDocument, EPUB, RTF, e-mail or HTML. Use it instead ' +
          'of reading such files directly: text costs a fraction of page images. Small documents come back whole, larger ' +
          'ones as an outline of headings; then ask for a `section` (by heading) or `pages`. Pages with handwriting, ' +
          'scans or drawings (no text layer) come back as compact images: after reading them, call save_transcription ' +
          'so the next read gets text instead.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'The document (absolute, or relative to the server root).' },
            mode: {
              type: 'string',
              enum: ['auto', 'full', 'skeleton', 'outline'],
              description: 'auto (default): whole if small, else outline. skeleton: headings plus the first sentences of each section.',
            },
            section: { type: 'string', description: 'Only the sections whose heading contains this text.' },
            pages: {
              description: 'Only these pages: an array of numbers or a string such as "3" or "2-5,9".',
              anyOf: [{ type: 'array', items: { type: 'number' } }, { type: 'string' }],
            },
            images: { type: 'boolean', description: 'Attach images of the pages in the result that need looking at (default true).' },
          },
          required: ['path'],
          additionalProperties: false,
        },
        run: async (args) => {
          const input = str(args, 'path', true)!;
          const mode = oneOf<ReadMode>(args, 'mode', ['auto', 'full', 'skeleton', 'outline']);
          const section = str(args, 'section');
          let pages: number[] | undefined;
          const rawPages = args.pages;
          if (rawPages !== undefined && rawPages !== null) {
            if (!(typeof rawPages === 'string' || (Array.isArray(rawPages) && rawPages.every((p) => Number.isInteger(p))))) {
              throw new RpcError(ErrorCode.InvalidParams, '"pages" must be an array of page numbers or a string such as "2-5"');
            }
            try {
              pages = parsePages(rawPages as string | number[]);
            } catch (error) {
              throw new RpcError(ErrorCode.InvalidParams, (error as Error).message);
            }
          }
          const file = await this.resolvePath(input);
          const info = await stat(file).catch(() => undefined);
          if (!info?.isFile()) throw new ToolError(`${input} is not a file`);
          if (!documentFormat(file, true)) throw new ToolError(`${input} is not a supported document; use skeleton_file or Read for code and text`);
          let result;
          try {
            result = await readDocument(file, { mode, section, pages, root: this.transcriptFolder(file) });
          } catch (error) {
            if (error instanceof DocumentError) throw new ToolError(error.message);
            throw error;
          }
          const content: ToolContent[] = [{ type: 'text', text: result.text }];
          const wanted = args.images === false ? [] : result.pending.slice(0, MAX_DOCUMENT_IMAGES);
          const images = wanted.length && result.document.format === 'pdf' ? await renderPdfPages(result.document.bytes, wanted.map((v) => v.page)) : [];
          for (const image of images) {
            content.push({ type: 'text', text: `Page ${image.page}:` });
            content.push({ type: 'image', data: Buffer.from(image.png).toString('base64'), mimeType: 'image/png' });
          }
          const rest = result.pending.length - wanted.length;
          if (images.length) {
            content.push({
              type: 'text',
              text:
                `Transcribe what ${images.length === 1 ? 'this page says' : 'these pages say'} and call save_transcription ` +
                `(path, pages: [{ page, text }]) so later reads return the text instead of images.` +
                (rest > 0 ? ` ${rest} more page${rest === 1 ? '' : 's'} need looking at: request them with \`pages\`.` : ''),
            });
          } else if (result.pending.length && args.images !== false) {
            content.push({ type: 'text', text: `Pages ${result.pending.map((v) => v.page).join(', ')} hold handwriting or images: request them with \`pages\` to see them.` });
          }
          return {
            content,
            structuredContent: {
              path: input,
              format: result.document.format,
              pages: result.document.pages ?? null,
              view: result.view,
              tokens: result.tokens,
              documentTokens: result.documentTokens,
              imagePages: images.map((i) => i.page),
              imageTokens: images.reduce((n, i) => n + i.tokens, 0),
              pendingPages: result.pending.map((v) => v.page),
              // Some clients show the model only structuredContent: the text must be in it too.
              text: result.text,
            },
          };
        },
      },
      {
        name: 'save_transcription',
        title: 'Save transcription',
        description:
          'Save what pages of a document say (pages read_document returned as images: handwriting, scans, drawings), so ' +
          'future reads return this text instead of images, in this and later sessions. Stored in the project under ' +
          '.astpack/transcripts/, keyed by the document content (commit it to share it across machines).',
        writes: true,
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'The document (absolute, or relative to the server root).' },
            pages: {
              type: 'array',
              items: {
                type: 'object',
                properties: { page: { type: 'number' }, text: { type: 'string', description: 'The page content as Markdown: text, lists, formulas, descriptions of drawings.' } },
                required: ['page', 'text'],
                additionalProperties: false,
              },
              description: 'One entry per page.',
            },
          },
          required: ['path', 'pages'],
          additionalProperties: false,
        },
        run: async (args) => {
          const input = str(args, 'path', true)!;
          const entries = args.pages;
          if (
            !Array.isArray(entries) ||
            !entries.length ||
            !entries.every((e) => e && typeof e === 'object' && Number.isInteger((e as { page: unknown }).page) && typeof (e as { text: unknown }).text === 'string')
          ) {
            throw new RpcError(ErrorCode.InvalidParams, '"pages" must be a non-empty array of { page, text }');
          }
          const file = await this.resolvePath(input);
          if (!documentFormat(file, true)) throw new ToolError(`${input} is not a supported document`);
          const bytes = await readFile(file);
          const folder = this.transcriptFolder(file);
          const pages: Record<string, string> = {};
          for (const e of entries as { page: number; text: string }[]) {
            if (e.page < 1) throw new RpcError(ErrorCode.InvalidParams, `invalid page ${e.page}`);
            pages[String(e.page)] = e.text;
          }
          const written = await saveTranscripts(folder, contentHash(bytes), file, pages);
          const list = Object.keys(pages).join(', ');
          return {
            content: [{ type: 'text', text: `Saved page${entries.length === 1 ? '' : 's'} ${list} of ${input} to ${relative(this.cwd, written) || written}.` }],
            structuredContent: { path: input, pages: Object.keys(pages).map(Number), file: written },
          };
        },
      },
    ];
  }
}

/**
 * Shown to the model in every session that has the server: when astpack beats reading files,
 * and when it doesn't. Kept short, since it costs context on every turn.
 */
export const SERVER_INSTRUCTIONS = [
  'astpack reads code as skeletons: signatures, types, classes, imports and docs, with function bodies replaced',
  'by placeholders, typically 50-80% fewer tokens than the raw files.',
  'Use it when you need to understand code rather than change it:',
  '- Starting work in a project you have not seen in this session (a new session, another machine, a fresh clone):',
  '  call pack_codebase with mode "outline" (or the default skeleton for small projects) before reading files one by one.',
  '- Finding where something is implemented: pack_codebase with `query` describing it.',
  '- Learning what a file or module offers (its API, not its internals): skeleton_file, which takes several paths at once.',
  '- Catching up on changes made elsewhere: pack_codebase with `changed` (e.g. "ORIG_HEAD" after a pull) and the rest as skeletons.',
  '- Reading a document (PDF, Word, PowerPoint, Excel, OpenDocument, EPUB, RTF, e-mail): read_document instead of Read.',
  '  It returns text (an outline first when long); handwritten or scanned pages come back as images: transcribe them',
  '  with save_transcription so later reads get text.',
  'Read code files normally when you are about to edit them, need exact implementation details, or the file is small.',
  'estimate_tokens tells you what a pack would cost before you request it.',
].join('\n');

const MAX_SKELETON_FILES = 20;
/** Page images attached to one read_document result. */
const MAX_DOCUMENT_IMAGES = 8;

/** Serve MCP over stdio (newline-delimited JSON-RPC). Resolves when stdin closes. */
export async function serveStdio(server: AstpackMcpServer, input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Promise<void> {
  let buffer = '';
  const pending = new Set<Promise<void>>();
  const send = (message: unknown) => output.write(`${JSON.stringify(message)}\n`);

  const handleLine = (line: string) => {
    if (!line.trim()) return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: ErrorCode.ParseError, message: 'Parse error' } });
      return;
    }
    const messages = Array.isArray(message) ? message : [message];
    const task = Promise.all(messages.map((m) => server.handle(m))).then((responses) => {
      const out = responses.filter((r): r is JsonRpcResponse => r !== undefined);
      if (!out.length) return;
      send(Array.isArray(message) ? out : out[0]);
    });
    const tracked = task.finally(() => pending.delete(tracked));
    pending.add(tracked);
  };

  await new Promise<void>((resolveDone) => {
    input.setEncoding?.('utf8');
    input.on('data', (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        handleLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
    });
    input.on('end', () => {
      if (buffer) handleLine(buffer);
      resolveDone();
    });
  });
  await Promise.all(pending);
}
