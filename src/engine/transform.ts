import { embeddedForPath, languageForPath, LANGUAGES, type EmbeddedSpec } from '../languages/index.js';
import type { CommentMode } from '../languages/types.js';
import { redactSecrets, type RedactionHit } from '../security/secrets.js';
import { skeletonize } from './skeleton.js';

export type FileMode = 'skeleton' | 'full';

/** How a file's content was produced. */
export type Strategy =
  /** AST-transformed with bodies stripped. */
  | 'skeleton'
  /** Included verbatim (full mode, focus target, or small unsupported file). */
  | 'full'
  /** Unsupported language in skeleton mode, cut at the fallback limit. */
  | 'truncated'
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

/** Produce the packaged content for a single file. */
export async function transformFile(filePath: string, content: string, options: TransformOptions): Promise<TransformedFile> {
  const result = await transformContent(filePath, content, options);
  if (options.redact === false) return result;
  const redacted = redactSecrets(result.content);
  return redacted.hits.length ? { ...result, content: redacted.content, redactions: redacted.hits } : result;
}

async function transformContent(filePath: string, content: string, options: TransformOptions): Promise<TransformedFile> {
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
    const result = await transformEmbedded(content, embedded, bodies, { ...options, comments });
    return { ...result, strategy: bodies ? 'skeleton' : 'full', language, redactions: [] };
  }

  const language = languageForPath(filePath);
  if (language) {
    if (!bodies && comments === 'all') return verbatim(language);
    let result;
    try {
      result = await skeletonize(content, language, { placeholder: options.placeholder, comments, bodies });
    } catch {
      // A grammar crashed on this input: fall back to what we'd do for an unknown language.
      const fallback = bodies ? truncate(content, { ...DEFAULT_FALLBACK, ...options.fallback }) : { content, truncated: false };
      return { ...verbatim(language), content: fallback.content, strategy: fallback.truncated ? 'truncated' : 'full', parseErrors: true };
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
