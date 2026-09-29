import { readFile } from 'node:fs/promises';
import { transformFile, type FallbackLimits, type FileMode, type Strategy } from './engine/transform.js';
import type { LanguageId } from './languages/index.js';
import { mapLimit } from './util/pool.js';
import { FocusMatcher, walk, type SkippedEntry, type WalkOptions } from './walker/index.js';

export interface PackOptions extends WalkOptions {
  /** `skeleton` (default) strips bodies; `full` includes raw source. */
  mode?: FileMode;
  /** Files, directories or globs kept as full source while everything else is skeletonized. */
  focus?: readonly string[];
  /** Marker text for stripped bodies. */
  placeholder?: string;
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
  language?: LanguageId;
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
  sh: 'bash', bash: 'bash', zsh: 'zsh', fish: 'fish', ps1: 'powershell', sql: 'sql', graphql: 'graphql', gql: 'graphql',
  proto: 'protobuf', dockerfile: 'dockerfile', java: 'java', kt: 'kotlin', kts: 'kotlin', swift: 'swift', c: 'c',
  h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', cs: 'csharp', rb: 'ruby', php: 'php', lua: 'lua',
  scala: 'scala', dart: 'dart', ex: 'elixir', exs: 'elixir', erl: 'erlang', hs: 'haskell', ml: 'ocaml', r: 'r',
  vue: 'vue', svelte: 'svelte', astro: 'astro', tf: 'hcl', hcl: 'hcl', nix: 'nix', zig: 'zig', svg: 'svg', txt: 'text',
  csv: 'csv', env: 'dotenv', mk: 'makefile', cmake: 'cmake', gradle: 'groovy', groovy: 'groovy', pl: 'perl',
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
      fallback: options.fallback,
    });
    options.onProgress?.(++done, walked.files.length, entry.path);
    return {
      path: entry.path,
      size: entry.size,
      language: result.language?.id,
      fence: result.language?.fence ?? fenceFor(entry.path),
      strategy: result.strategy,
      focused,
      content: result.content,
      original,
      strippedBodies: result.strippedBodies,
      parseErrors: result.parseErrors,
    };
  });

  return { root: walked.root, mode, files, skipped: walked.skipped, focusOutsideRoot: focus.outsideRoot() };
}
