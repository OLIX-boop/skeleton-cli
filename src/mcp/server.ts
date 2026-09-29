import { stat } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { fitToBudget } from '../budget.js';
import { transformFile } from '../engine/transform.js';
import { changedFiles } from '../git.js';
import type { CommentMode } from '../languages/types.js';
import { render, type OutputFormat } from '../output/index.js';
import { pack, readText } from '../pack.js';
import { computeStats, DEFAULT_MODELS, TokenCounter } from '../tokens/index.js';
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

interface ToolResult {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
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
    this.roots = options.roots.map((r) => resolve(r));
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
          instructions:
            'astpack packs a codebase into one LLM-ready document. Use pack_codebase with `focus` for the files you are ' +
            'working on (kept verbatim) while the rest is reduced to signatures and types. Use estimate_tokens first ' +
            'on large repositories, and skeleton_file to read the API of a single file cheaply.',
        };
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return undefined;
      case 'ping':
        return {};
      case 'tools/list':
        return {
          tools: this.tools.map(({ name, title, description, inputSchema }) => ({
            name,
            title,
            description,
            inputSchema,
            annotations: { readOnlyHint: true, openWorldHint: false },
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

  /** Resolve a tool path argument and make sure it stays inside an allowed root. */
  private resolvePath(input: string): string {
    const abs = isAbsolute(input) ? resolve(input) : resolve(this.cwd, input);
    const allowed = this.roots.some((root) => {
      const rel = relative(root, abs);
      return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !rel.startsWith(`..${sep}`));
    });
    if (!allowed) throw new ToolError(`${input} is outside the allowed roots (${this.roots.join(', ')})`);
    return abs;
  }

  private defineTools(): ToolDefinition[] {
    const packProperties = {
      path: { type: 'string', description: 'Project directory (absolute, or relative to the server root).' },
      focus: {
        type: 'array',
        items: { type: 'string' },
        description: 'Files, directories or globs (relative to `path`) to include as full source.',
      },
      changed: { type: 'string', description: 'Also focus files changed vs this git ref (e.g. "HEAD" or "main").' },
      mode: { type: 'string', enum: ['skeleton', 'full'], description: 'skeleton (default) strips function bodies; full keeps them.' },
      comments: commentsSchema,
      include: { type: 'array', items: { type: 'string' }, description: 'Only include files matching these gitignore-style patterns.' },
      ignore: { type: 'array', items: { type: 'string' }, description: 'Extra gitignore-style patterns to exclude.' },
      maxTokens: { type: 'number', description: 'Compress and omit files until the document fits this many tokens.' },
    };

    const runPack = async (args: Record<string, unknown>) => {
      const root = this.resolvePath(str(args, 'path', true)!);
      const info = await stat(root).catch(() => undefined);
      if (!info?.isDirectory()) throw new ToolError(`${root} is not a directory`);
      const focus = strList(args, 'focus').map((f) => (/[*?[\]{}]/.test(f) ? f : resolve(root, f)));
      const changed = str(args, 'changed');
      if (changed) focus.push(...(await changedFiles(root, changed)));
      const comments = oneOf<CommentMode>(args, 'comments', ['all', 'docs', 'none']);
      const result = await pack(root, {
        mode: oneOf(args, 'mode', ['skeleton', 'full'] as const) ?? 'skeleton',
        focus,
        cwd: root,
        comments,
        include: strList(args, 'include'),
        ignore: strList(args, 'ignore'),
      });
      return { root, result, comments };
    };

    return [
      {
        name: 'pack_codebase',
        title: 'Pack codebase',
        description:
          'Pack a project into a single LLM-ready document: a directory tree plus every file, with function bodies ' +
          'replaced by placeholders (signatures, types, classes and comments kept). Focused files stay verbatim. ' +
          'Respects .gitignore and skips dependencies, lockfiles, binaries and secrets.',
        inputSchema: {
          type: 'object',
          properties: {
            ...packProperties,
            format: { type: 'string', enum: ['markdown', 'xml', 'json'], description: 'Document format (default markdown).' },
          },
          required: ['path'],
          additionalProperties: false,
        },
        run: async (args) => {
          const format = oneOf<OutputFormat>(args, 'format', ['markdown', 'xml', 'json']) ?? 'markdown';
          const maxTokens = num(args, 'maxTokens');
          const { root, result: packed, comments } = await runPack(args);
          const renderOptions = { projectName: basename(root) };
          let result = packed;
          let document = render(format, result, renderOptions);
          if (maxTokens) {
            const report = await fitToBudget(result, { maxTokens, render: (r) => render(format, r, renderOptions), comments });
            result = report.result;
            document = report.document;
          }
          const stats = computeStats(result, document, { models: [...DEFAULT_MODELS] });
          return {
            content: [{ type: 'text', text: document }],
            structuredContent: {
              files: stats.filesIncluded,
              tokens: stats.tokens.cl100k_base.output,
              rawTokens: stats.tokens.cl100k_base.baseline,
              savedPercent: Math.round(stats.savedRatio * 100),
            },
          };
        },
      },
      {
        name: 'estimate_tokens',
        title: 'Estimate tokens',
        description:
          'Report how many tokens pack_codebase would produce for a project (and how many the raw source would take), ' +
          'plus the largest files, without returning the document. Use it to choose focus/include/maxTokens.',
        inputSchema: {
          type: 'object',
          properties: { ...packProperties, top: { type: 'number', description: 'How many of the largest files to list (default 10).' } },
          required: ['path'],
          additionalProperties: false,
        },
        run: async (args) => {
          const top = num(args, 'top') ?? 10;
          const { root, result } = await runPack(args);
          const document = render('markdown', result, { projectName: basename(root) });
          const stats = computeStats(result, document, { models: [...DEFAULT_MODELS] });
          const cl = stats.tokens.cl100k_base;
          const lines = [
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
            },
          };
        },
      },
      {
        name: 'skeleton_file',
        title: 'Skeleton of a file',
        description:
          "Return one source file with function bodies stripped: its imports, types, signatures and docs. A cheap way to read a file's API.",
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path (absolute, or relative to the server root).' },
            comments: commentsSchema,
          },
          required: ['path'],
          additionalProperties: false,
        },
        run: async (args) => {
          const file = this.resolvePath(str(args, 'path', true)!);
          const info = await stat(file).catch(() => undefined);
          if (!info?.isFile()) throw new ToolError(`${file} is not a file`);
          const content = await readText(file);
          const out = await transformFile(file, content, {
            mode: 'skeleton',
            comments: oneOf<CommentMode>(args, 'comments', ['all', 'docs', 'none']),
            fallback: { maxLines: 400, maxChars: 40_000 },
          });
          const counter = new TokenCounter();
          try {
            const tokens = counter.count(out.content);
            const rawTokens = counter.count(content);
            return {
              content: [{ type: 'text', text: out.content }],
              structuredContent: { language: out.language?.id ?? null, strategy: out.strategy, tokens, rawTokens },
            };
          } finally {
            counter.free();
          }
        },
      },
    ];
  }
}

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
