import { isAbsolute, relative, resolve } from 'node:path';
import { changedFiles, git, repoRoot } from './git.js';
import type { PackedFile, PackResult } from './pack.js';
import { toPosix } from './walker/rules.js';

/**
 * File order in the document:
 * - `path`: files before sub-directories, alphabetically (the default, like the tree).
 * - `stable`: least recently changed first (by git history, uncommitted changes last), so
 *   the start of the document stays the same between runs and LLM prompt caches, which
 *   match on a prefix, keep hitting.
 * - `size`: smallest first.
 */
export const FILE_ORDERS = ['path', 'stable', 'size'] as const;
export type FileOrder = (typeof FILE_ORDERS)[number];

/** How far back history is read for `stable` (older files share the oldest rank). */
const HISTORY_COMMITS = 5000;

/**
 * When each file under `cwd` last changed, as commit time in seconds (uncommitted and
 * untracked files get `Infinity`). Keys are POSIX paths relative to `cwd`. Files not seen in
 * the recent history are absent.
 */
export async function lastChanged(cwd: string): Promise<Map<string, number>> {
  const root = await repoRoot(cwd);
  const log = await git(['-c', 'core.quotePath=false', 'log', `-n${HISTORY_COMMITS}`, '--no-renames', '--name-only', '--format=@%ct', 'HEAD', '--'], root, 256 * 1024 * 1024);
  const times = new Map<string, number>();
  const toCwd = (repoPath: string) => {
    const rel = relative(cwd, resolve(root, repoPath));
    return rel.startsWith('..') || isAbsolute(rel) ? undefined : toPosix(rel);
  };
  let time = 0;
  for (const line of log.split('\n')) {
    if (line.startsWith('@')) time = Number(line.slice(1));
    else if (line) {
      const path = toCwd(line);
      // Newest commits come first: keep the first time seen.
      if (path !== undefined && !times.has(path)) times.set(path, time);
    }
  }
  for (const abs of await changedFiles(cwd)) times.set(toPosix(relative(cwd, abs)), Number.POSITIVE_INFINITY);
  return times;
}

/** Reorder a pack's files. `stable` needs git; outside a repository it keeps path order. */
export async function orderFiles(result: PackResult, order: FileOrder): Promise<PackResult> {
  if (order === 'path') return result;
  const files = [...result.files];
  const byPath = (a: PackedFile, b: PackedFile) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (order === 'size') {
    files.sort((a, b) => a.content.length - b.content.length || byPath(a, b));
  } else {
    let times: Map<string, number>;
    try {
      times = await lastChanged(result.root);
    } catch {
      return result;
    }
    // Stable sort keeps the walker's order among files changed in the same commit.
    files.sort((a, b) => (times.get(a.path) ?? 0) - (times.get(b.path) ?? 0));
  }
  return { ...result, files };
}
