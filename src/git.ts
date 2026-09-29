import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export class GitError extends Error {}

/** Run git and return stdout. */
export function git(args: readonly string[], cwd: string, maxBuffer = 64 * 1024 * 1024): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile('git', args as string[], { cwd, maxBuffer, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') reject(new GitError('git is not installed or not on PATH'));
        else reject(new GitError((stderr || error.message).trim()));
        return;
      }
      resolvePromise(stdout);
    });
  });
}

export async function repoRoot(cwd: string): Promise<string> {
  try {
    return (await git(['rev-parse', '--show-toplevel'], cwd)).trim();
  } catch {
    throw new GitError(`${cwd} is not inside a git repository`);
  }
}

/** The commit to diff against: the merge-base of `ref` and HEAD, so upstream changes don't leak in. */
async function diffBase(ref: string, cwd: string): Promise<string> {
  if (ref === 'HEAD') return 'HEAD';
  try {
    return (await git(['merge-base', ref, 'HEAD'], cwd)).trim();
  } catch {
    // Unrelated histories or a non-branch ref: diff against the ref itself.
    await git(['rev-parse', '--verify', `${ref}^{commit}`], cwd).catch(() => {
      throw new GitError(`unknown git ref: ${ref}`);
    });
    return ref;
  }
}

function lines(output: string): string[] {
  return output.split('\n').map((l) => l.trim()).filter(Boolean);
}

/**
 * Absolute paths of files changed relative to `ref` (default `HEAD`): committed changes since
 * the merge-base, plus staged, unstaged and (for HEAD) untracked files. Deleted files are
 * left out.
 */
export async function changedFiles(cwd: string, ref = 'HEAD'): Promise<string[]> {
  const root = await repoRoot(cwd);
  const base = await diffBase(ref, root);
  const changed = new Set(lines(await git(['diff', '--name-only', '--no-renames', base, '--'], root)));
  for (const f of lines(await git(['ls-files', '--others', '--exclude-standard'], root))) changed.add(f);
  return [...changed]
    .map((f) => resolve(root, f))
    .filter((f) => existsSync(f))
    .sort();
}

/** Unified diff of the working tree against `ref`'s merge-base (untracked files excluded). */
export async function diffText(cwd: string, ref = 'HEAD', paths: readonly string[] = []): Promise<string> {
  const root = await repoRoot(cwd);
  const base = await diffBase(ref, root);
  return git(['diff', '--no-color', '--no-ext-diff', base, '--', ...paths], root);
}

export interface RemoteSpec {
  url: string;
  /** Name for the packed project (repo name). */
  name: string;
  branch?: string;
}

/**
 * Parse `owner/repo`, `owner/repo#branch`, `github.com/owner/repo` or any git URL
 * (optionally with `#branch`).
 */
export function parseRemote(input: string): RemoteSpec {
  let spec = input.trim();
  let branch: string | undefined;
  const hash = spec.lastIndexOf('#');
  if (hash > 0) {
    branch = spec.slice(hash + 1) || undefined;
    spec = spec.slice(0, hash);
  }
  // GitHub tree URLs: https://github.com/o/r/tree/branch
  const tree = /^(https?:\/\/github\.com\/[^/]+\/[^/]+)\/tree\/(.+)$/.exec(spec);
  if (tree) {
    spec = tree[1]!;
    branch ??= tree[2];
  }
  let url: string;
  if (/^[\w.-]+\/[\w.-]+$/.test(spec)) url = `https://github.com/${spec}.git`;
  else if (/^(github|gitlab)\.com\/[\w.-]+\/[\w.-]+/.test(spec)) url = `https://${spec}`;
  else url = spec;
  const name = url.replace(/\/+$/, '').replace(/\.git$/, '').split(/[/:]/).pop() || 'repo';
  return { url, name, branch };
}

/** Shallow-clone a remote repository into a temporary directory. */
export async function cloneRemote(spec: RemoteSpec): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const parent = await mkdtemp(join(tmpdir(), 'astpack-remote-'));
  const dir = join(parent, spec.name);
  const cleanup = () => rm(parent, { recursive: true, force: true });
  const args = ['clone', '--depth', '1', '--single-branch', '--no-tags', '--quiet'];
  if (spec.branch) args.push('--branch', spec.branch);
  args.push(spec.url, dir);
  try {
    await git(args, parent);
  } catch (error) {
    await cleanup();
    throw new GitError(`failed to clone ${spec.url}: ${(error as Error).message}`);
  }
  return { dir, cleanup };
}
