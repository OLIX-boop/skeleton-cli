import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FocusMatcher, looksBinary, walk } from '../src/walker/index.js';
import { makeSymlink, makeTree } from './fixtures.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

async function tree(files: Record<string, string | Uint8Array>) {
  const t = await makeTree(files);
  cleanups.push(t.cleanup);
  return t.root;
}

const paths = (r: { files: { path: string }[] }) => r.files.map((f) => f.path);

describe('walk', () => {
  it('lists files in a stable order: files first, then directories', async () => {
    const root = await tree({
      'b.ts': '',
      'a.ts': '',
      'src/z.ts': '',
      'src/lib/y.ts': '',
      'src/a.ts': '',
      'docs/readme.md': '',
    });
    expect(paths(await walk(root))).toEqual(['a.ts', 'b.ts', 'docs/readme.md', 'src/a.ts', 'src/z.ts', 'src/lib/y.ts']);
  });

  it('applies built-in excludes for dependencies, lockfiles, binaries and generated files', async () => {
    const root = await tree({
      'index.ts': 'x',
      'node_modules/pkg/index.js': 'x',
      '.git/config': 'x',
      'package-lock.json': '{}',
      'Cargo.lock': '',
      'logo.png': 'x',
      'app.min.js': 'x',
      'app.js.map': '{}',
      'src/__pycache__/m.pyc': 'x',
    });
    const result = await walk(root);
    expect(paths(result)).toEqual(['index.ts']);
    expect(result.skipped.map((s) => s.path).sort()).toEqual(
      ['.git/', 'Cargo.lock', 'app.js.map', 'app.min.js', 'logo.png', 'node_modules/', 'package-lock.json', 'src/__pycache__/'].sort(),
    );
    expect(result.skipped.every((s) => s.reason === 'ignored')).toBe(true);
  });

  it('excludes likely secret files but keeps templates', async () => {
    const root = await tree({
      '.env': 'KEY=1',
      '.env.production': 'KEY=1',
      '.env.example': 'KEY=',
      'certs/server.pem': 'x',
      '.ssh/id_ed25519': 'x',
      '.ssh/id_ed25519.pub': 'x',
      '.npmrc': '//registry.npmjs.org/:_authToken=x',
      'a.ts': '',
    });
    expect(paths(await walk(root))).toEqual(['.env.example', 'a.ts']);
  });

  it('can disable built-in excludes', async () => {
    const root = await tree({ 'yarn.lock': 'x', 'a.ts': '' });
    expect(paths(await walk(root, { defaultIgnores: false }))).toEqual(['a.ts', 'yarn.lock']);
  });

  it('respects root and nested .gitignore files, including negation', async () => {
    const root = await tree({
      '.gitignore': '*.log\nsecret/\ngenerated/*\n!generated/keep.ts\n',
      'a.ts': '',
      'debug.log': '',
      'secret/key.ts': '',
      'generated/drop.ts': '',
      'generated/keep.ts': '',
      'pkg/.gitignore': 'local.ts\n/rooted.ts\n',
      'pkg/local.ts': '',
      'pkg/rooted.ts': '',
      'pkg/sub/rooted.ts': '',
      'pkg/ok.ts': '',
      'other/local.ts': '',
    });
    expect(paths(await walk(root))).toEqual([
      '.gitignore',
      'a.ts',
      'generated/keep.ts',
      'other/local.ts',
      'pkg/.gitignore',
      'pkg/ok.ts',
      'pkg/sub/rooted.ts',
    ]);
  });

  it('can ignore .gitignore files entirely', async () => {
    const root = await tree({ '.gitignore': 'a.ts\n', 'a.ts': '' });
    expect(paths(await walk(root, { gitignore: false }))).toEqual(['.gitignore', 'a.ts']);
  });

  it('applies the repository .gitignore when scanning a sub-directory', async () => {
    const root = await tree({
      '.git/HEAD': 'ref: refs/heads/main',
      '.gitignore': 'packages/app/tmp/\n*.gen.ts\n',
      'packages/app/index.ts': '',
      'packages/app/types.gen.ts': '',
      'packages/app/tmp/x.ts': '',
    });
    expect(paths(await walk(join(root, 'packages/app')))).toEqual(['index.ts']);
  });

  it('honours .git/info/exclude', async () => {
    const root = await tree({ '.git/info/exclude': 'scratch.ts\n', 'scratch.ts': '', 'a.ts': '' });
    expect(paths(await walk(root))).toEqual(['a.ts']);
  });

  it('respects .packignore and --ignore patterns', async () => {
    const root = await tree({
      '.packignore': 'fixtures/\n',
      'a.ts': '',
      'a.test.ts': '',
      'fixtures/big.json': '',
      'src/.astpackignore': 'legacy.ts\n',
      'src/legacy.ts': '',
      'src/new.ts': '',
    });
    const result = await walk(root, { ignore: ['*.test.ts'] });
    expect(paths(result)).toEqual(['.packignore', 'a.ts', 'src/.astpackignore', 'src/new.ts']);
  });

  it('limits output to --include patterns', async () => {
    const root = await tree({ 'a.ts': '', 'b.py': '', 'src/c.ts': '', 'README.md': '' });
    const result = await walk(root, { include: ['*.ts'] });
    expect(paths(result)).toEqual(['a.ts', 'src/c.ts']);
    expect(result.skipped.filter((s) => s.reason === 'not-included').map((s) => s.path)).toEqual(['README.md', 'b.py']);
  });

  it('skips files over the size limit and binary files', async () => {
    const root = await tree({
      'big.txt': 'x'.repeat(2000),
      'blob.dat': new Uint8Array([1, 2, 0, 3]),
      'ok.txt': 'hello',
      'empty.txt': '',
    });
    const result = await walk(root, { maxFileSize: 1000 });
    expect(paths(result)).toEqual(['empty.txt', 'ok.txt']);
    expect(result.skipped).toEqual([
      { path: 'big.txt', reason: 'too-large', size: 2000 },
      { path: 'blob.dat', reason: 'binary', size: 4 },
    ]);
    expect(paths(await walk(root, { maxFileSize: 0 }))).toContain('big.txt');
  });

  // Creating symlinks on Windows needs elevated privileges.
  it.skipIf(process.platform === 'win32')('skips symlinks by default and follows them safely when asked', async () => {
    const root = await tree({ 'real/a.ts': '' });
    await makeSymlink(root, 'real', 'link');
    await makeSymlink(root, '.', 'real/loop');
    const noFollow = await walk(root);
    expect(paths(noFollow)).toEqual(['real/a.ts']);
    expect(noFollow.skipped.map((s) => s.reason)).toEqual(['symlink', 'symlink']);
    const follow = await walk(root, { followSymlinks: true });
    // Each real directory is visited once, via the first path (alphabetically) to reach it.
    expect(paths(follow)).toEqual(['link/a.ts']);
  });

  it('rejects a non-directory root', async () => {
    const root = await tree({ 'a.ts': '' });
    await expect(walk(join(root, 'a.ts'))).rejects.toThrow(/Not a directory/);
  });

  it('handles empty directories', async () => {
    const root = await tree({});
    await mkdir(join(root, 'empty'));
    expect(await walk(root)).toMatchObject({ files: [], skipped: [] });
  });
});

describe('FocusMatcher', () => {
  it('matches files and whole directories relative to the working directory', () => {
    const m = new FocusMatcher(['src/auth', 'lib/util.ts'], '/repo', '/repo');
    expect(m.matches('src/auth/login.ts')).toBe(true);
    expect(m.matches('src/auth')).toBe(true);
    expect(m.matches('src/authz/x.ts')).toBe(false);
    expect(m.matches('lib/util.ts')).toBe(true);
    expect(m.matches('lib/util.tsx')).toBe(false);
  });

  it('resolves paths given from a different working directory', () => {
    const m = new FocusMatcher(['./login.ts', '/repo/lib/'], '/repo', '/repo/src/auth');
    expect(m.matches('src/auth/login.ts')).toBe(true);
    expect(m.matches('lib/a.ts')).toBe(true);
  });

  it('supports globs', () => {
    const m = new FocusMatcher(['**/*.test.ts'], '/repo', '/repo');
    expect(m.matches('src/a.test.ts')).toBe(true);
    expect(m.matches('src/a.ts')).toBe(false);
  });

  it('treats an existing path with glob characters as a path', async () => {
    const root = await tree({ 'app/[id]/page.tsx': '', 'app/i/page.tsx': '' });
    const m = new FocusMatcher(['app/[id]'], root, root);
    expect(m.matches('app/[id]/page.tsx')).toBe(true);
    expect(m.matches('app/i/page.tsx')).toBe(false);
  });

  it('focuses everything for "." and reports targets outside the root', () => {
    expect(new FocusMatcher(['.'], '/repo', '/repo').matches('any/file.ts')).toBe(true);
    const m = new FocusMatcher(['../other'], '/repo', '/repo');
    expect(m.outsideRoot()).toEqual(['../other']);
    expect(new FocusMatcher([], '/repo').isEmpty).toBe(true);
  });
});

describe('looksBinary', () => {
  it('detects NUL bytes', () => {
    expect(looksBinary(new TextEncoder().encode('plain text'))).toBe(false);
    expect(looksBinary(new Uint8Array([0x41, 0x00]))).toBe(true);
  });
});
