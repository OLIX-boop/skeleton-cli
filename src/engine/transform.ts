import { embeddedForPath, languageForPath, LANGUAGES, registeredExtensions, type EmbeddedSpec } from '../languages/index.js';
import { createHash } from 'node:crypto';
import type { CommentMode } from '../languages/types.js';
import { cacheStore } from '../cache/store.js';
import { isNotebook, notebookToScript } from '../languages/notebook.js';
import { activePool, WorkerFailure } from '../parallel/pool.js';
import { LruCache } from '../util/lru.js';
import { redactSecrets, type RedactionHit } from '../security/secrets.js';
import { outline } from './outline.js';
import { skeletonize } from './skeleton.js';

/** `full` keeps source, `skeleton` strips bodies, `outline` keeps only declaration signatures. */
export type FileMode = 'skeleton' | 'full' | 'outline';

/** How a file's content was produced. */
export type Strategy =
  /** AST-transformed with bodies stripped. */
  | 'skeleton'
  /** Included verbatim (full mode, focus target, or small unsupported file). */
  | 'full'
  /** Only the declarations and signatures, one per line. */
  | 'outline'
  /** Unsupported language in skeleton mode, cut at the fallback limit. */
  | 'truncated'
  /** Minified or packed code (very long lines), replaced by a one-line note. */
  | 'minified'
  /** Dropped to fit a token budget; listed in the tree only. */
  | 'omitted';

export interface FallbackLimits {
  /** Maximum lines of an unsupported file to include in skeleton mode (default 200). */
  maxLines: number;
  /** Maximum characters of an unsupported file to include in skeleton mode (default 16 000). */
  maxChars: number;
}

export const DEFAULT_FALLBACK: FallbackLimits = { maxLines: 200, maxChars: 16_000 };

export interface TransformOptions {
  mode: FileMode;
  placeholder?: string;
  /** Which comments to keep in supported languages (default `all`). */
  comments?: CommentMode;
  /** Mask likely secrets (API keys, tokens, private keys, passwords). Default true. */
  redact?: boolean;
  fallback?: Partial<FallbackLimits>;
}

/** The language a file was recognised as (a tree-sitter language or an embedded format). */
export interface FileLanguage {
  id: string;
  fence: string;
}

export interface TransformedFile {
  content: string;
  strategy: Strategy;
  language?: FileLanguage;
  strippedBodies: number;
  strippedComments: number;
  /** Secrets masked in the content. */
  redactions: RedactionHit[];
  /** The parser reported syntax errors; the skeleton is best-effort. */
  parseErrors: boolean;
}

/** Cut `content` to the fallback limits, appending a marker describing what was dropped. */
export function truncate(content: string, limits: FallbackLimits): { content: string; truncated: boolean } {
  let end = content.length;
  let lineCount = 0;
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10 && ++lineCount === limits.maxLines) {
      end = i + 1;
      break;
    }
  }
  end = Math.min(end, limits.maxChars);
  if (end >= content.length) return { content, truncated: false };

  // Prefer to cut on a line boundary.
  const lastNewline = content.lastIndexOf('\n', end - 1);
  if (lastNewline > 0) end = lastNewline + 1;
  const kept = content.slice(0, end);
  const rest = content.slice(end);
  const droppedLines = rest.split('\n').length - (rest.endsWith('\n') ? 1 : 0);
  return {
    content: `${kept}${kept.endsWith('\n') ? '' : '\n'}... [truncated: ${droppedLines} more line${droppedLines === 1 ? "" : "s"}, ${rest.length} chars]\n`,
    truncated: true,
  };
}

/** Skeletonize every script region of an embedded-language file, keeping markup verbatim. */
async function transformEmbedded(content: string, spec: EmbeddedSpec, bodies: boolean, options: TransformOptions) {
  let out = '';
  let cursor = 0;
  let strippedBodies = 0;
  let strippedComments = 0;
  let parseErrors = false;
  for (const region of spec.regions(content)) {
    const result = await skeletonize(content.slice(region.start, region.end), LANGUAGES[region.language], {
      placeholder: options.placeholder,
      comments: options.comments,
      bodies,
    });
    out += content.slice(cursor, region.start) + result.code;
    cursor = region.end;
    strippedBodies += result.strippedBodies;
    strippedComments += result.strippedComments;
    parseErrors ||= result.hasErrors;
  }
  return { content: out + content.slice(cursor), strippedBodies, strippedComments, parseErrors };
}

/** Outline a supported file (script regions only for embedded formats), or `undefined`. */
async function outlineContent(filePath: string, content: string): Promise<TransformedFile | undefined> {
  const embedded = embeddedForPath(filePath);
  const language = languageForPath(filePath);
  if (!embedded && !language) return undefined;
  try {
    let text = '';
    let hasErrors = false;
    if (embedded) {
      for (const region of embedded.regions(content)) {
        const result = await outline(content.slice(region.start, region.end), LANGUAGES[region.language]);
        text += result.text;
        hasErrors ||= result.hasErrors;
      }
    } else {
      const result = await outline(content, language!);
      text = result.text;
      hasErrors = result.hasErrors;
    }
    return {
      content: text,
      strategy: 'outline',
      language: embedded ? { id: embedded.id, fence: embedded.fence } : language,
      strippedBodies: 0,
      strippedComments: 0,
      redactions: [],
      parseErrors: hasErrors,
    };
  } catch {
    return undefined;
  }
}

/** A grammar crashed on this input: fall back to what we'd do for an unknown language. */
function crashFallback(content: string, language: FileLanguage, bodies: boolean, options: TransformOptions): TransformedFile {
  const cut = bodies ? truncate(content, { ...DEFAULT_FALLBACK, ...options.fallback }) : { content, truncated: false };
  return {
    content: cut.content,
    strategy: cut.truncated ? 'truncated' : 'full',
    language,
    strippedBodies: 0,
    strippedComments: 0,
    redactions: [],
    parseErrors: true,
  };
}

/**
 * Results of recent transforms, keyed by a hash of the file type, options and content.
 * Makes repeated packs (MCP calls, --watch, budget passes) skip unchanged files.
 */
const cache = new LruCache<string, TransformedFile>(20_000, 256 * 1024 * 1024, (f) => f.content.length * 2 + 256);

function cacheKey(filePath: string, content: string, options: TransformOptions): string {
  const kind = isNotebook(filePath) ? 'notebook' : (embeddedForPath(filePath)?.id ?? languageForPath(filePath)?.id ?? '');
  return createHash('sha1')
    .update(JSON.stringify([kind, options.mode, options.comments, options.placeholder, options.fallback, options.redact !== false]))
    .update('\0')
    .update(content)
    .digest('base64');
}

type StoredTransform = Omit<TransformedFile, 'content'> & { content?: string; same?: boolean };

/** Unchanged content (full source) is stored as a flag rather than a second copy. */
function storable(result: TransformedFile, source: string): StoredTransform {
  return result.content === source ? { ...result, content: undefined, same: true } : result;
}

/** Forget cached transforms (e.g. in tests). */
export function clearTransformCache(): void {
  cache.clear();
}

/** Transform without consulting caches (what worker threads run). */
export async function computeTransform(filePath: string, content: string, options: TransformOptions): Promise<TransformedFile> {
  let result: TransformedFile;
  const notebook = isNotebook(filePath) ? notebookToScript(content) : undefined;
  if (notebook) {
    // Transform the notebook's code as a script in its kernel language (outputs dropped).
    result = await transformContent(filePath + notebook.extension, notebook.text, options);
    result = { ...result, language: { id: 'notebook', fence: notebook.fence } };
  } else {
    result = await transformContent(filePath, content, options);
  }
  // Only the id and fence are part of the result (not the whole language spec), so results
  // stay small and serializable.
  if (result.language) result = { ...result, language: { id: result.language.id, fence: result.language.fence } };
  if (options.redact !== false) {
    const redacted = redactSecrets(result.content);
    if (redacted.hits.length) result = { ...result, content: redacted.content, redactions: redacted.hits };
  }
  return result;
}

/** Produce the packaged content for a single file. */
export async function transformFile(filePath: string, content: string, options: TransformOptions): Promise<TransformedFile> {
  const key = cacheKey(filePath, content, options);
  const store = cacheStore();
  const cached = cache.get(key);
  if (cached) {
    // Keep the entry in the on-disk cache too, or saving would drop it.
    if (store && store.get('transform', key) === undefined) store.set('transform', key, storable(cached, content));
    return cached;
  }
  const stored = store?.get<StoredTransform>('transform', key);
  if (stored) {
    const { same, ...rest } = stored;
    const restored = { ...rest, content: same ? content : stored.content! } as TransformedFile;
    cache.set(key, restored);
    return restored;
  }
  const pool = activePool();
  let result: TransformedFile;
  try {
    result = pool
      ? await pool.run<TransformedFile>({ type: 'transform', path: filePath, content, options, extensions: registeredExtensions() })
      : await computeTransform(filePath, content, options);
  } catch (error) {
    // A worker that died (e.g. out of memory) shouldn't fail the pack: retry here.
    if (!pool || !(error instanceof WorkerFailure)) throw error;
    result = await computeTransform(filePath, content, options);
  }
  // A crash fallback may be transient (parser reset); don't pin it.
  if (!(result.parseErrors && result.strippedBodies === 0 && result.strategy !== 'skeleton')) {
    cache.set(key, result);
    store?.set('transform', key, storable(result, content));
  }
  return result;
}

/**
 * Minified bundles, source maps inlined as data and similar machine-written text: long
 * enough to matter, with lines far longer than anyone writes by hand.
 */
export function isMinified(content: string): boolean {
  if (content.length < 4096) return false;
  let lines = 1;
  let longest = 0;
  let start = 0;
  for (let i = content.indexOf('\n'); i !== -1; i = content.indexOf('\n', i + 1)) {
    lines++;
    longest = Math.max(longest, i - start);
    start = i + 1;
  }
  longest = Math.max(longest, content.length - start);
  return longest >= 2000 && content.length / lines > 300;
}

/**
 * A comment near the top saying the file is generated: `// Code generated by protoc-gen-go.
 * DO NOT EDIT.`, `@generated`, `# This file is automatically generated`, `/* autogenerated *\/`.
 */
const COMMENT = String.raw`^[ \t]*(?:\/\/+|#+|\/?\*+|--|<!--|;+|"""|''')[ \t!]*`;
/** The comment starts by saying so: `AUTOGENERATED`, `Code generated by…`, `This file was generated…`. */
const GENERATED_LEAD = new RegExp(`${COMMENT}(?:(?:this|the) (?:file|code|module) (?:is|was|has been) )?(?:automatically |auto-)?(?:auto-?generated|generated|code generated)\\b`, 'im');
/** Or carries a conventional marker anywhere in it (case-sensitive, as tools write them). */
const GENERATED_MARK = new RegExp(`${COMMENT}.*?(?:@generated\\b|\\bDO NOT EDIT\\b)`, 'm');

const PROSE = /\.(md|mdx|markdown|txt|rst|adoc|asciidoc|tex|org|textile)$/i;

export function isGenerated(content: string): boolean {
  const head = content.slice(0, 600);
  return GENERATED_LEAD.test(head) || GENERATED_MARK.test(head);
}

async function transformContent(filePath: string, content: string, options: TransformOptions): Promise<TransformedFile> {
  // Prose puts whole paragraphs on one line; only code and data count as minified.
  if (options.mode !== 'full' && !PROSE.test(filePath) && isMinified(content)) {
    const lines = content.split('\n').length;
    const language = embeddedForPath(filePath) ?? languageForPath(filePath);
    return {
      content: `[minified: ${lines} line${lines === 1 ? '' : 's'}, ${content.length} chars omitted]\n`,
      strategy: 'minified',
      language: language ? { id: language.id, fence: language.fence } : undefined,
      strippedBodies: 0,
      strippedComments: 0,
      redactions: [],
      parseErrors: false,
    };
  }
  // Generated code (protobuf stubs, ORM clients…) is read through its API: outline it.
  if (options.mode === 'skeleton' && isGenerated(content)) {
    const result = await outlineContent(filePath, content);
    if (result?.content.trim()) return result;
  }
  if (options.mode === 'outline') {
    const result = await outlineContent(filePath, content);
    if (result?.content.trim()) return result;
    // No outline for this file type, or nothing to list (re-export barrels, config files):
    // treat it like skeleton mode.
    return transformContent(filePath, content, { ...options, mode: 'skeleton' });
  }
  const comments = options.comments ?? 'all';
  const bodies = options.mode === 'skeleton';
  const verbatim = (language?: FileLanguage): TransformedFile => ({
    content,
    strategy: 'full',
    language,
    strippedBodies: 0,
    strippedComments: 0,
    redactions: [],
    parseErrors: false,
  });

  const embedded = embeddedForPath(filePath);
  if (embedded) {
    const language = { id: embedded.id, fence: embedded.fence };
    if (!bodies && comments === 'all') return verbatim(language);
    try {
      const result = await transformEmbedded(content, embedded, bodies, { ...options, comments });
      return { ...result, strategy: bodies ? 'skeleton' : 'full', language, redactions: [] };
    } catch {
      return crashFallback(content, language, bodies, options);
    }
  }

  const language = languageForPath(filePath);
  if (language) {
    if (!bodies && comments === 'all') return verbatim(language);
    let result;
    try {
      result = await skeletonize(content, language, { placeholder: options.placeholder, comments, bodies });
    } catch {
      return crashFallback(content, language, bodies, options);
    }
    return {
      content: result.code,
      strategy: bodies ? 'skeleton' : 'full',
      language,
      strippedBodies: result.strippedBodies,
      strippedComments: result.strippedComments,
      redactions: [],
      parseErrors: result.hasErrors,
    };
  }

  if (!bodies) return verbatim();
  const cut = truncate(content, { ...DEFAULT_FALLBACK, ...options.fallback });
  return { ...verbatim(), content: cut.content, strategy: cut.truncated ? 'truncated' : 'full' };
}
