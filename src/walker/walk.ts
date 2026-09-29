import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import ignore from 'ignore';
import { isBinaryFile } from './binary.js';
import { DEFAULT_MAX_FILE_SIZE, defaultIgnorePatterns } from './defaults.js';
import { ancestorDirsWithinRepo, IgnoreRules, relPosix } from './rules.js';

export interface WalkOptions {
  /** Honour `.gitignore` files (root, nested, repo ancestors and `.git/info/exclude`). Default true. */
  gitignore?: boolean;
  /** Honour `.packignore` / `.astpackignore` files. Default true. */
  packignore?: boolean;
  /** Apply the built-in excludes (dependencies, lockfiles, binaries...). Default true. */
  defaultIgnores?: boolean;
  /** Extra gitignore-style patterns to exclude. */
  ignore?: readonly string[];
  /** If non-empty, only files matching one of these gitignore-style patterns are included. */
  include?: readonly string[];
  /** Skip files larger than this many bytes. Default 1 MiB. `0` or `Infinity` disables the limit. */
  maxFileSize?: number;
  /** Follow symbolic links (cycle-safe). Default false. */
  followSymlinks?: boolean;
}

export interface FileEntry {
  /** POSIX path relative to the scan root. */
  path: string;
  absPath: string;
  size: number;
}

export type SkipReason = 'ignored' | 'not-included' | 'too-large' | 'binary' | 'symlink' | 'unreadable';

export interface SkippedEntry {
  /** POSIX path relative to the root; ignored directories end with `/`. */
  path: string;
  reason: SkipReason;
  size?: number;
}

export interface WalkResult {
  root: string;
  files: FileEntry[];
  /** Entries that were seen but not included. An ignored directory is reported once. */
  skipped: SkippedEntry[];
}

export const PACKIGNORE_FILES = ['.packignore', '.astpackignore'] as const;

interface Collected {
  files: FileEntry[];
  skipped: SkippedEntry[];
}

interface Candidate {
  name: string;
  path: string;
  abs: string;
}

function byName(a: Candidate, b: Candidate): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * Recursively discover the files under `root` that should be packaged.
 *
 * Results are in a stable order: within each directory, files first (alphabetical), then
 * sub-directories (alphabetical).
 */
export async function walk(root: string, options: WalkOptions = {}): Promise<WalkResult> {
  const absRoot = resolve(root);
  if (!(await stat(absRoot)).isDirectory()) throw new Error(`Not a directory: ${root}`);

  const opts = { gitignore: true, packignore: true, defaultIgnores: true, followSymlinks: false, ...options };
  const maxSize = opts.maxFileSize === undefined ? DEFAULT_MAX_FILE_SIZE : opts.maxFileSize || Infinity;
  const include = opts.include?.length ? ignore({ allowRelativePaths: true }).add([...opts.include]) : undefined;
  const visited = new Set<string>();

  let rules = IgnoreRules.empty();
  if (opts.defaultIgnores) rules = rules.with('', defaultIgnorePatterns());
  if (opts.gitignore) {
    // When packing a sub-directory of a repo, the repo's own ignore files still apply.
    for (const dir of await ancestorDirsWithinRepo(absRoot)) {
      const prefix = relPosix(dir, absRoot);
      for (const file of [join(dir, '.git', 'info', 'exclude'), join(dir, '.gitignore')]) {
        const content = await readFile(file, 'utf8').catch(() => undefined);
        if (content !== undefined) rules = rules.withAncestor(prefix, content);
      }
    }
    rules = await rules.withFile(join(absRoot, '.git', 'info'), '', 'exclude');
  }
  if (opts.ignore?.length) rules = rules.with('', opts.ignore);

  async function checkFile(f: Candidate): Promise<FileEntry | SkippedEntry> {
    if (include && !include.ignores(f.path)) return { path: f.path, reason: 'not-included' };
    try {
      const { size } = await (opts.followSymlinks ? stat(f.abs) : lstat(f.abs));
      if (size > maxSize) return { path: f.path, reason: 'too-large', size };
      if (size > 0 && (await isBinaryFile(f.abs))) return { path: f.path, reason: 'binary', size };
      return { path: f.path, absPath: f.abs, size };
    } catch {
      return { path: f.path, reason: 'unreadable' };
    }
  }

  async function visit(absDir: string, base: string, inherited: IgnoreRules): Promise<Collected> {
    const out: Collected = { files: [], skipped: [] };
    if (opts.followSymlinks) {
      const real = await realpath(absDir);
      if (visited.has(real)) return out;
      visited.add(real);
    }

    let dirRules = inherited;
    if (opts.gitignore) dirRules = await dirRules.withFile(absDir, base, '.gitignore');
    if (opts.packignore) {
      for (const name of PACKIGNORE_FILES) dirRules = await dirRules.withFile(absDir, base, name);
    }

    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      out.skipped.push({ path: base ? `${base}/` : './', reason: 'unreadable' });
      return out;
    }

    const fileCandidates: Candidate[] = [];
    const dirCandidates: Candidate[] = [];
    for (const entry of entries) {
      const path = base ? `${base}/${entry.name}` : entry.name;
      const abs = join(absDir, entry.name);
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        if (!opts.followSymlinks) {
          out.skipped.push({ path, reason: 'symlink' });
          continue;
        }
        const target = await stat(abs).catch(() => undefined);
        if (!target) {
          out.skipped.push({ path, reason: 'unreadable' });
          continue;
        }
        isDir = target.isDirectory();
        isFile = target.isFile();
      }
      if (!isDir && !isFile) continue; // sockets, FIFOs, devices
      if (dirRules.ignores(path, isDir)) {
        out.skipped.push({ path: isDir ? `${path}/` : path, reason: 'ignored' });
        continue;
      }
      (isDir ? dirCandidates : fileCandidates).push({ name: entry.name, path, abs });
    }

    for (const result of await Promise.all(fileCandidates.sort(byName).map(checkFile))) {
      if ('reason' in result) out.skipped.push(result);
      else out.files.push(result);
    }
    dirCandidates.sort(byName);
    // With symlinks followed, the first path to reach a directory claims it, so walk
    // sequentially to keep that deterministic. Otherwise walk concurrently.
    const subdirs: Collected[] = [];
    if (opts.followSymlinks) {
      for (const d of dirCandidates) subdirs.push(await visit(d.abs, d.path, dirRules));
    } else {
      subdirs.push(...(await Promise.all(dirCandidates.map((d) => visit(d.abs, d.path, dirRules)))));
    }
    for (const sub of subdirs) {
      out.files.push(...sub.files);
      out.skipped.push(...sub.skipped);
    }
    return out;
  }

  const { files, skipped } = await visit(absRoot, '', rules);
  return { root: absRoot, files, skipped };
}
