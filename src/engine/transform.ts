import { languageForPath, type LanguageSpec } from '../languages/index.js';
import { skeletonize } from './skeleton.js';

export type FileMode = 'skeleton' | 'full';

/** How a file's content was produced. */
export type Strategy =
  /** AST-transformed with bodies stripped. */
  | 'skeleton'
  /** Included verbatim (full mode, focus target, or small unsupported file). */
  | 'full'
  /** Unsupported language in skeleton mode, cut at the fallback limit. */
  | 'truncated';

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
  fallback?: Partial<FallbackLimits>;
}

export interface TransformedFile {
  content: string;
  strategy: Strategy;
  language?: LanguageSpec;
  strippedBodies: number;
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

/** Produce the packaged content for a single file. */
export async function transformFile(
  filePath: string,
  content: string,
  options: TransformOptions,
): Promise<TransformedFile> {
  const language = languageForPath(filePath);
  if (options.mode === 'full') {
    return { content, strategy: 'full', language, strippedBodies: 0, parseErrors: false };
  }
  if (language) {
    const result = await skeletonize(content, language, { placeholder: options.placeholder });
    return {
      content: result.code,
      strategy: 'skeleton',
      language,
      strippedBodies: result.strippedBodies,
      parseErrors: result.hasErrors,
    };
  }
  const limits = { ...DEFAULT_FALLBACK, ...options.fallback };
  const cut = truncate(content, limits);
  return {
    content: cut.content,
    strategy: cut.truncated ? 'truncated' : 'full',
    strippedBodies: 0,
    parseErrors: false,
  };
}
