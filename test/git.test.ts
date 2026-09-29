import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli/program.js';
import { changedFiles, cloneRemote, diffText, parseRemote } from '../src/git.js';
import { makeTree } from './fixtures.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

const hasGit = (() => {
  try {
    execFileSync('git', ['--version']);
    return true;
  } catch {
    return false;
  }
})();

function g(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], {
    cwd,
    encoding: 'utf8',
  });
}

async function repo() {
  const t = await makeTree({
    'src/a.ts': 'export function a() {\n  return 1;\n}\n',
    'src/b.ts': 'export function b() {\n  return 2;\n}\n',
    'src/c.ts': 'export function c() {\n  return 3;\n}\n',
  });
  cleanups.push(t.cleanup);
  g(t.root, 'init', '-q');
  g(t.root, 'add', '.');
  g(t.root, 'commit', '-qm', 'init');
  return t.root;
}

class Capture extends Writable {
  data = '';
  override _write(chunk: Buffer, _e: string, cb: () => void) {
    this.data += chunk.toString();
    cb();
  }
}

async function cli(args: string[], cwd: string) {
  const stdout = new Capture();
  const stderr = new Capture();
  const code = await run(args, { stdout: stdout as unknown as NodeJS.WriteStream, stderr: stderr as unknown as NodeJS.WriteStream, cwd });
  return { code, stdout: stdout.data, stderr: stderr.data };
}

// Spawning git is slow on Windows runners; allow each test more time.
describe.skipIf(!hasGit)('--order stable', { timeout: 30_000 }, () => {
  it('lists least recently changed files first, uncommitted changes and the diff last', async () => {
    const root = await repo();
    // Commit times have one-second resolution: date the commits explicitly.
    const at = (date: string, ...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
        cwd: root,
        env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
      });
    at('2030-01-01T00:00:00Z', 'commit', '-q', '--amend', '--no-edit', '--date=2030-01-01T00:00:00Z');
    await writeFile(join(root, 'src/a.ts'), 'export function a() {\n  return 10;\n}\n');
    g(root, 'add', '.');
    at('2030-02-01T00:00:00Z', 'commit', '-qm', 'change a');
    await writeFile(join(root, 'src/b.ts'), 'export function b() {\n  return 20;\n}\n');

    const order = (out: string) => [...out.matchAll(/^### `(src\/\w\.ts)`/gm)].map((m) => m[1]);
    const { stdout } = await cli(['--stdout', '-q', '--no-tree', '--order', 'stable', '--diff'], root);
    expect(order(stdout)).toEqual(['src/c.ts', 'src/a.ts', 'src/b.ts']);
    expect(stdout.indexOf('## Git diff')).toBeGreaterThan(stdout.indexOf('### `src/b.ts`'));
    expect(order((await cli(['--stdout', '-q', '--no-tree'], root)).stdout)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
  });

  it('keeps path order outside a git repository', async () => {
    const t = await makeTree({ 'b.ts': 'export const b = 1;\n', 'a.ts': 'export const a = 1;\n' });
    cleanups.push(t.cleanup);
    const { stdout, code } = await cli(['--stdout', '-q', '--no-tree', '--order', 'stable'], t.root);
    expect(code).toBe(0);
    expect(stdout.indexOf('`a.ts`')).toBeLessThan(stdout.indexOf('`b.ts`'));
  });
});

describe.skipIf(!hasGit)('git integration', { timeout: 30_000 }, () => {
  it('lists uncommitted, staged and untracked changes vs HEAD', async () => {
    const root = await repo();
    await writeFile(join(root, 'src/a.ts'), 'export function a() {\n  return 10;\n}\n');
    await writeFile(join(root, 'src/new.ts'), 'export const n = 1;\n');
    await writeFile(join(root, 'src/b.ts'), 'export function b() {\n  return 20;\n}\n');
    g(root, 'add', 'src/b.ts');
    const changed = (await changedFiles(root)).map((p) => p.slice(root.length + 1).replace(/\\/g, '/'));
    expect(changed).toEqual(['src/a.ts', 'src/b.ts', 'src/new.ts']);
  });

  it('handles non-ASCII paths and only reports files under the given directory', async () => {
    const root = await repo();
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(root, 'other'));
    await writeFile(join(root, 'src/café.ts'), 'export const c = 1;\n');
    await writeFile(join(root, 'other/x.ts'), 'export const x = 1;\n');
    const inSrc = (await changedFiles(join(root, 'src'))).map((p) => p.slice(root.length + 1).replace(/\\/g, '/'));
    expect(inSrc).toEqual(['src/café.ts']);
  });

  it('lists changes since the merge-base with a branch', async () => {
    const root = await repo();
    g(root, 'checkout', '-qb', 'feature');
    await writeFile(join(root, 'src/c.ts'), 'export function c() {\n  return 30;\n}\n');
    g(root, 'commit', '-qam', 'change c');
    g(root, 'checkout', '-q', 'main');
    await writeFile(join(root, 'src/a.ts'), 'export function a() {\n  return 11;\n}\n');
    g(root, 'commit', '-qam', 'main moves on');
    g(root, 'checkout', '-q', 'feature');
    const changed = (await changedFiles(root, 'main')).map((p) => p.slice(root.length + 1).replace(/\\/g, '/'));
    // a.ts changed on main after branching; it must not show up.
    expect(changed).toEqual(['src/c.ts']);
    expect(await diffText(root, 'main')).toContain('+  return 30;');
  });

  it('resolves @base to the base branch', async () => {
    const root = await repo();
    g(root, 'checkout', '-qb', 'feature');
    await writeFile(join(root, 'src/c.ts'), 'export function c() {\n  return 30;\n}\n');
    g(root, 'commit', '-qam', 'change c');
    const { resolveRef } = await import('../src/git.js');
    expect(await resolveRef('@base', root)).toBe('main');
    expect(await resolveRef('v1', root)).toBe('v1');
    const { stdout } = await cli(['--stdout', '-q', '--preset', 'review'], root);
    expect(stdout).toContain('### `src/c.ts` [focus]');
    expect(stdout).toContain('## Git diff (vs `main`)');
  });

  it('rejects unknown refs and non-repositories', async () => {
    const root = await repo();
    await expect(changedFiles(root, 'no-such-branch')).rejects.toThrow(/unknown git ref/);
    const plain = await makeTree({ 'a.ts': '' });
    cleanups.push(plain.cleanup);
    // A temp dir may itself live inside some repository; only assert when it doesn't.
    const inRepo = (() => {
      try {
        execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: plain.root, stdio: 'pipe' });
        return true;
      } catch {
        return false;
      }
    })();
    if (!inRepo) await expect(changedFiles(plain.root)).rejects.toThrow(/not inside a git repository/);
  });

  it('focuses changed files and includes the diff from the CLI', async () => {
    const root = await repo();
    await writeFile(join(root, 'src/a.ts'), 'export function a() {\n  return 10;\n}\n');
    const { code, stdout } = await cli(['--stdout', '-q', '--changed', '--diff'], root);
    expect(code).toBe(0);
    expect(stdout).toContain('### `src/a.ts` [focus]');
    expect(stdout).toContain('return 10;');
    expect(stdout).toContain('export function b() { /* ... */ }');
    expect(stdout).toContain('## Git diff (vs `HEAD`)');
    expect(stdout).toContain('-  return 1;\n+  return 10;');
  });

  it('packs a remote repository via a shallow clone', async () => {
    const root = await repo();
    const { code, stdout } = await cli(['--stdout', '-q', '--remote', `file://${root.replace(/\\/g, '/')}`, '--focus', 'src/a.ts'], root);
    expect(code).toBe(0);
    expect(stdout).toContain('export function c() { /* ... */ }');
    // Relative focus paths resolve inside the clone.
    expect(stdout).toContain('### `src/a.ts` [focus]');
    // Config focus paths also resolve inside the clone.
    const cwd = await makeTree({ 'astpack.config.json': JSON.stringify({ focus: ['src/b.ts'] }) });
    cleanups.push(cwd.cleanup);
    const viaConfig = await cli(['--stdout', '-q', '--remote', `file://${root.replace(/\\/g, '/')}`], cwd.root);
    expect(viaConfig.stdout).toContain('### `src/b.ts` [focus]');
    const clone = await cloneRemote(parseRemote(`file://${root.replace(/\\/g, '/')}`));
    cleanups.push(clone.cleanup);
    await expect(cloneRemote({ url: 'file:///definitely/missing', name: 'x' })).rejects.toThrow(/failed to clone/);
  });
});

describe('parseRemote', () => {
  it.each([
    ['vercel/next.js', { url: 'https://github.com/vercel/next.js.git', name: 'next.js' }],
    ['owner/repo#dev', { url: 'https://github.com/owner/repo.git', name: 'repo', branch: 'dev' }],
    ['github.com/a/b', { url: 'https://github.com/a/b', name: 'b' }],
    ['https://github.com/a/b/tree/feat/x', { url: 'https://github.com/a/b', name: 'b', branch: 'feat/x' }],
    ['git@github.com:a/b.git', { url: 'git@github.com:a/b.git', name: 'b' }],
    ['https://gitlab.com/g/sub/proj.git#v1', { url: 'https://gitlab.com/g/sub/proj.git', name: 'proj', branch: 'v1' }],
  ])('%s', (input, expected) => {
    expect(parseRemote(input)).toEqual({ branch: undefined, ...expected });
  });
});
