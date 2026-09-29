import { afterEach, describe, expect, it } from 'vitest';
import { fenceFor, pack } from '../src/pack.js';
import { makeTree } from './fixtures.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

async function project() {
  const t = await makeTree({
    'README.md': '# Demo\n',
    'src/auth/login.ts': 'export function login(u: string): boolean {\n  return u === "admin";\n}\n',
    'src/db.py': 'def connect(url: str):\n    return open(url)\n',
    'src/main.go': 'package main\n\nfunc main() {\n\tprintln("hi")\n}\n',
    'win.ts': '﻿export function f() {\r\n  return 1;\r\n}\r\n',
    'package-lock.json': '{}',
  });
  cleanups.push(t.cleanup);
  return t.root;
}

describe('pack', () => {
  it('skeletonizes supported files by default', async () => {
    const root = await project();
    const result = await pack(root);
    expect(result.mode).toBe('skeleton');
    expect(result.files.map((f) => [f.path, f.strategy, f.fence])).toEqual([
      ['README.md', 'full', 'markdown'],
      ['win.ts', 'skeleton', 'ts'],
      ['src/db.py', 'skeleton', 'python'],
      ['src/main.go', 'skeleton', 'go'],
      ['src/auth/login.ts', 'skeleton', 'ts'],
    ]);
    const login = result.files.find((f) => f.path === 'src/auth/login.ts')!;
    expect(login.content).toBe('export function login(u: string): boolean { /* ... */ }\n');
    expect(login.original).toContain('return u === "admin"');
    expect(result.skipped).toEqual([{ path: 'package-lock.json', reason: 'ignored' }]);
  });

  it('normalizes BOM and CRLF line endings', async () => {
    const root = await project();
    const win = (await pack(root)).files.find((f) => f.path === 'win.ts')!;
    expect(win.original).toBe('export function f() {\n  return 1;\n}\n');
    expect(win.content).toBe('export function f() { /* ... */ }\n');
  });

  it('keeps focused files as full source and skeletonizes the rest', async () => {
    const root = await project();
    const result = await pack(root, { focus: ['src/auth'], cwd: root });
    const byPath = Object.fromEntries(result.files.map((f) => [f.path, f]));
    expect(byPath['src/auth/login.ts']).toMatchObject({ focused: true, strategy: 'full' });
    expect(byPath['src/auth/login.ts']!.content).toContain('return u === "admin"');
    expect(byPath['src/db.py']).toMatchObject({ focused: false, strategy: 'skeleton' });
  });

  it('includes raw source in full mode', async () => {
    const root = await project();
    const result = await pack(root, { mode: 'full' });
    expect(result.files.every((f) => f.strategy === 'full' && f.content === f.original)).toBe(true);
  });

  it('reports progress', async () => {
    const root = await project();
    const seen: number[] = [];
    await pack(root, { onProgress: (done) => seen.push(done) });
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('fenceFor', () => {
  it.each([
    ['a/Dockerfile', 'dockerfile'],
    ['Makefile', 'makefile'],
    ['config.yml', 'yaml'],
    ['.env.local', 'dotenv'],
    ['LICENSE', 'text'],
    ['x.unknown', 'text'],
    ['init.lua', 'lua'],
    ['src/a.py', 'python'],
    ['App.vue', 'vue'],
  ])('%s -> %s', (path, fence) => {
    expect(fenceFor(path)).toBe(fence);
  });
});
