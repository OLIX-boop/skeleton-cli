import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cacheInfo, clearCache, defaultCacheDir, FileCacheStore, openCache, setCacheStore } from '../src/cache/store.js';
import { clearTransformCache, transformFile } from '../src/engine/transform.js';
import { chunks, TokenCounter } from '../src/tokens/counter.js';

const dirs: string[] = [];
async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'astpack-cache-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  setCacheStore(undefined);
  clearTransformCache();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('FileCacheStore', () => {
  it('persists entries across instances and keeps only those used by the last run', async () => {
    const dir = await tempDir();
    const first = new FileCacheStore('/project', dir);
    first.set('tokens', 'a', 1);
    first.set('tokens', 'b', 2);
    first.save();

    const second = new FileCacheStore('/project', dir);
    expect(second.get('tokens', 'a')).toBe(1);
    second.save();

    const third = new FileCacheStore('/project', dir);
    expect(third.get('tokens', 'a')).toBe(1);
    expect(third.get('tokens', 'b')).toBeUndefined();
    expect(new FileCacheStore('/other', dir).get('tokens', 'a')).toBeUndefined();
  });

  it('skips unchanged saves and keeps only what each run (or watch rebuild) used', async () => {
    const dir = await tempDir();
    const store = new FileCacheStore('/project', dir);
    store.set('tokens', 'a', 1);
    store.set('tokens', 'b', 2);
    store.save();
    const { mtimeMs } = await stat(store.path);
    const again = new FileCacheStore('/project', dir);
    again.get('tokens', 'a');
    again.get('tokens', 'b');
    await new Promise((r) => setTimeout(r, 20));
    again.save();
    expect((await stat(again.path)).mtimeMs).toBe(mtimeMs);
    // Next "rebuild" only uses a: b is dropped.
    again.get('tokens', 'a');
    again.save();
    const reopened = new FileCacheStore('/project', dir);
    expect(reopened.get('tokens', 'a')).toBe(1);
    expect(reopened.get('tokens', 'b')).toBeUndefined();
  });

  it('ignores corrupt files and reports and clears the cache', async () => {
    const dir = await tempDir();
    const store = new FileCacheStore('/project', dir);
    store.set('tokens', 'x', 5);
    store.save();
    expect(cacheInfo(dir).files).toBe(1);
    await writeFile(store.path, 'not gzip');
    expect(new FileCacheStore('/project', dir).get('tokens', 'x')).toBeUndefined();
    clearCache(dir);
    expect(cacheInfo(dir)).toMatchObject({ files: 0, bytes: 0 });
  });

  it('resolves the platform cache directory and honours the opt-outs', () => {
    expect(defaultCacheDir({ ASTPACK_CACHE_DIR: '/c' })).toBe('/c');
    expect(defaultCacheDir({ XDG_CACHE_HOME: '/xdg' }, 'linux')).toBe(join('/xdg', 'astpack'));
    expect(defaultCacheDir({ LOCALAPPDATA: 'C:\\L' }, 'win32')).toBe(join('C:\\L', 'astpack', 'Cache'));
    expect(openCache('/p', { ASTPACK_NO_CACHE: '1' })).toBeUndefined();
    expect(openCache('/p', { ASTPACK_NO_CACHE: '0', ASTPACK_CACHE_DIR: '/c' })).toBeInstanceOf(FileCacheStore);
  });
});

describe('persistent transforms and token counts', () => {
  it('reuses stored transforms, storing unchanged content only as a flag', async () => {
    const dir = await tempDir();
    const store = new FileCacheStore('/p', dir);
    setCacheStore(store);
    const src = 'export function f(): number {\n  return 1;\n}\n';
    const skeleton = await transformFile('a.ts', src, { mode: 'skeleton' });
    const full = await transformFile('a.ts', src, { mode: 'full' });
    store.save();

    clearTransformCache();
    const reopened = new FileCacheStore('/p', dir);
    setCacheStore(reopened);
    expect(await transformFile('a.ts', src, { mode: 'skeleton' })).toEqual(skeleton);
    expect(await transformFile('a.ts', src, { mode: 'full' })).toEqual(full);
    const stored = Object.values((reopened as unknown as { used: Record<string, Record<string, { same?: boolean; content?: string }>> }).used.transform!);
    expect(stored.some((e) => e.same && e.content === undefined)).toBe(true);
  });

  it('counts long texts in chunks that add up exactly', () => {
    const text = Array.from({ length: 4000 }, (_, i) => (i % 7 === 0 ? `  indented ${i}\n` : i % 11 === 0 ? `/ slash ${i}\n` : `line ${i} = value;\n`)).join('');
    const parts = [...chunks(text)];
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join('')).toBe(text);
    for (const p of parts.slice(1)) expect(p[0]).toMatch(/[^\s/]/);
    const counter = new TokenCounter();
    const direct = parts.reduce((n, p) => n + counter.count(p), 0);
    expect(counter.count(text)).toBe(direct);
  });
});
