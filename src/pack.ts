import { readFile } from 'node:fs/promises';
import type { CommentMode } from './languages/types.js';
import { transformFile, type FallbackLimits, type FileMode, type Strategy } from './engine/transform.js';
import type { RedactionHit } from './security/secrets.js';
import { mapLimit } from './util/pool.js';
import { FocusMatcher, walk, type SkippedEntry, type WalkOptions } from './walker/index.js';

export interface PackOptions extends WalkOptions {
  /** `skeleton` (default) strips bodies; `full` includes raw source; `outline` lists declarations only. */
  mode?: FileMode;
  /** Files, directories or globs kept as full source while everything else is skeletonized. */
  focus?: readonly string[];
  /** Marker text for stripped bodies. */
  placeholder?: string;
  /** Which comments to keep in non-focused files of supported languages (default `all`). */
  comments?: CommentMode;
  /** Mask likely secrets in every file, focused ones included. Default true. */
  redact?: boolean;
  /** Limits for unsupported files in skeleton mode. */
  fallback?: Partial<FallbackLimits>;
  /** Directory relative focus paths are resolved against. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Maximum files processed concurrently. Default 32. */
  concurrency?: number;
  /** Called after each file is processed (for progress reporting). */
  onProgress?: (done: number, total: number, path: string) => void;
}

export interface PackedFile {
  /** POSIX path relative to the root. */
  path: string;
  /** Size on disk in bytes. */
  size: number;
  /** Language id (e.g. `typescript`, `python`, `vue`), if recognised. */
  language?: string;
  /** Code-fence language hint. */
  fence: string;
  strategy: Strategy;
  /** Whether the file matched a `--focus` target. */
  focused: boolean;
  /** Packaged content. */
  content: string;
  /** Original file content (line endings normalized), used for savings analytics. */
  original: string;
  strippedBodies: number;
  strippedComments: number;
  /** Secrets masked in `content`. */
  redactions: RedactionHit[];
  parseErrors: boolean;
}

export interface PackResult {
  root: string;
  mode: FileMode;
  files: PackedFile[];
  skipped: SkippedEntry[];
  /** Focus targets that resolved outside the root. */
  focusOutsideRoot: string[];
}

/** Code-fence hints for common non-AST file types. */
const FENCE_BY_EXTENSION: Record<string, string> = {
  md: 'markdown', mdx: 'mdx', json: 'json', jsonc: 'jsonc', json5: 'json5', yml: 'yaml', yaml: 'yaml', toml: 'toml',
  ini: 'ini', cfg: 'ini', xml: 'xml', html: 'html', htm: 'html', css: 'css', scss: 'scss', sass: 'sass', less: 'less',
  zsh: 'zsh', fish: 'fish', ps1: 'powershell', bat: 'batch', cmd: 'batch', sql: 'sql', graphql: 'graphql',
  gql: 'graphql', proto: 'protobuf', erl: 'erlang', hs: 'haskell', ml: 'ocaml', r: 'r', jl: 'julia',
  tf: 'hcl', hcl: 'hcl', nix: 'nix', zig: 'zig', sol: 'solidity', svg: 'svg', txt: 'text', csv: 'csv', mk: 'makefile',
  cmake: 'cmake', gradle: 'groovy', groovy: 'groovy', pl: 'perl', m: 'objectivec', mm: 'objectivec', vim: 'vim',
  prisma: 'prisma', tex: 'latex', rst: 'rst', adoc: 'asciidoc',
};

const FENCE_BY_NAME: Record<string, string> = {
  dockerfile: 'dockerfile', makefile: 'makefile', gnumakefile: 'makefile', justfile: 'just', gemfile: 'ruby',
  rakefile: 'ruby', vagrantfile: 'ruby', procfile: 'text', 'cmakelists.txt': 'cmake',
};

export function fenceFor(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  if (FENCE_BY_NAME[name]) return FENCE_BY_NAME[name];
  if (name === '.env' || name.startsWith('.env.')) return 'dotenv';
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return 'text';
  return FENCE_BY_EXTENSION[name.slice(dot + 1)] ?? 'text';
}

/** Outlines aren't valid code in the file's language, so don't highlight them as such. */
export function fenceForStrategy(strategy: string, fence: string): string {
  return strategy === 'outline' ? 'text' : fence;
}

/** Read a text file, dropping a UTF-8 BOM and normalizing CRLF line endings. */
export async function readText(absPath: string): Promise<string> {
  let text = await readFile(absPath, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text.includes('\r\n') ? text.replace(/\r\n/g, '\n') : text;
}

/** Discover, filter and transform every file under `root`. */
export async function pack(root: string, options: PackOptions = {}): Promise<PackResult> {
  const mode = options.mode ?? 'skeleton';
  const walked = await walk(root, options);
  const focus = new FocusMatcher(options.focus ?? [], walked.root, options.cwd);

  let done = 0;
  const files = await mapLimit(walked.files, options.concurrency ?? 32, async (entry): Promise<PackedFile> => {
    const original = await readText(entry.absPath);
    const focused = !focus.isEmpty && focus.matches(entry.path);
    const result = await transformFile(entry.path, original, {
      mode: focused ? 'full' : mode,
      placeholder: options.placeholder,
      comments: focused ? 'all' : options.comments,
      fallback: options.fallback,
      redact: options.redact,
    });
    options.onProgress?.(++done, walked.files.length, entry.path);
    return {
      path: entry.path,
      size: entry.size,
      language: result.language?.id,
      fence: fenceForStrategy(result.strategy, result.language?.fence ?? fenceFor(entry.path)),
      strategy: result.strategy,
      focused,
      content: result.content,
      original,
      strippedBodies: result.strippedBodies,
      strippedComments: result.strippedComments,
      redactions: result.redactions,
      parseErrors: result.parseErrors,
    };
  });

  return { root: walked.root, mode, files, skipped: walked.skipped, focusOutsideRoot: focus.outsideRoot() };
}
