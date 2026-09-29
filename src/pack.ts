import { readFile } from 'node:fs/promises';
import type { CommentMode } from './languages/types.js';
import { transformFile, type FallbackLimits, type FileMode, type Strategy } from './engine/transform.js';
import type { RedactionHit } from './security/secrets.js';
import { embeddedForPath, languageForPath } from './languages/index.js';
import { dependencyGraph, relatedFiles } from './deps.js';
import { search, topHits, type SearchHit } from './search.js';
import { mapLimit } from './util/pool.js';
import { FocusMatcher, walk, type SkippedEntry, type WalkOptions } from './walker/index.js';

export interface PackOptions extends WalkOptions {
  /** `skeleton` (default) strips bodies; `full` includes raw source; `outline` lists declarations only. */
  mode?: FileMode;
  /** Files, directories or globs kept as full source while everything else is skeletonized. */
  focus?: readonly string[];
  /**
   * Also keep as full source the files within this many import hops of a focused file
   * (what it imports and what imports it). Default 0.
   */
  related?: number;
  /**
   * Describe the task in words (e.g. `invoice pdf export`) and the most relevant files are
   * focused too, ranked by keyword relevance over identifiers and paths.
   */
  query?: string;
  /** Maximum number of files `query` focuses. Default 5. */
  queryLimit?: number;
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
  /** Whether the file is kept as full source because of `--focus` (or `related`). */
  focused: boolean;
  /** Focused only because it imports, or is imported by, a focus target (`related`). */
  related?: boolean;
  /** Focused because it matched `query`. */
  matched?: boolean;
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
  /** Files `query` focused, best first (absent without a query). */
  queryHits?: SearchHit[];
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
  const language = languageForPath(path) ?? embeddedForPath(path);
  if (language) return language.fence;
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

const TEST_PATH = /(^|\/)(tests?|__tests__|spec)\/|[._-](test|spec)\.[^/]+$|(^|\/)test_[^/]+$/;

/** Discover, filter and transform every file under `root`. */
export async function pack(root: string, options: PackOptions = {}): Promise<PackResult> {
  const mode = options.mode ?? 'skeleton';
  const walked = await walk(root, options);
  const focus = new FocusMatcher(options.focus ?? [], walked.root, options.cwd);

  const concurrency = options.concurrency ?? 32;
  const originals = await mapLimit(walked.files, concurrency, (entry) => readText(entry.absPath));
  const targets = new Set(focus.isEmpty ? [] : walked.files.filter((e) => focus.matches(e.path)).map((e) => e.path));
  let queryHits: SearchHit[] | undefined;
  if (options.query?.trim()) {
    // Code the parser understands outranks prose and config that merely mention the words,
    // and implementation outranks its tests (`related` can pull those in).
    const documents = walked.files.map((e, i) => ({
      path: e.path,
      text: originals[i]!,
      weight: !(languageForPath(e.path) || embeddedForPath(e.path)) ? 0.4 : TEST_PATH.test(e.path) ? 0.7 : 1,
    }));
    queryHits = topHits(search(documents, options.query), options.queryLimit ?? 5);
  }
  const matched = new Set(queryHits?.map((h) => h.path).filter((p) => !targets.has(p)));
  for (const path of matched) targets.add(path);
  let related = new Set<string>();
  if ((options.related ?? 0) > 0 && targets.size) {
    const sources = walked.files.map((e, i) => ({
      path: e.path,
      language: (languageForPath(e.path) ?? embeddedForPath(e.path))?.id,
      original: originals[i]!,
    }));
    related = relatedFiles(dependencyGraph({ files: sources }), targets, options.related!);
  }

  let done = 0;
  const indexed = walked.files.map((entry, i) => ({ entry, original: originals[i]! }));
  const files = await mapLimit(indexed, concurrency, async ({ entry, original }): Promise<PackedFile> => {
    const isRelated = related.has(entry.path);
    const focused = targets.has(entry.path) || isRelated;
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
      ...(isRelated ? { related: true } : {}),
      ...(matched.has(entry.path) ? { matched: true } : {}),
      content: result.content,
      original,
      strippedBodies: result.strippedBodies,
      strippedComments: result.strippedComments,
      redactions: result.redactions,
      parseErrors: result.parseErrors,
    };
  });

  return {
    root: walked.root,
    mode,
    files,
    skipped: walked.skipped,
    focusOutsideRoot: focus.outsideRoot(),
    ...(queryHits ? { queryHits } : {}),
  };
}
