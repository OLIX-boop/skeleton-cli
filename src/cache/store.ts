import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { VERSION } from '../version.js';

/**
 * Persistent cache of transform results and token counts, one file per packed project, so
 * a re-run only processes files that changed. Entries are content-addressed (keys hash the
 * content and options), so a stale entry is never returned; entries not used by a run are
 * dropped when it saves, which keeps each file the size of the latest pack.
 */
export interface CacheStore {
  get<T>(namespace: string, key: string): T | undefined;
  set(namespace: string, key: string, value: unknown): void;
}

let active: CacheStore | undefined;

/** Install (or with `undefined`, remove) the store transforms and token counts consult. */
export function setCacheStore(store: CacheStore | undefined): void {
  active = store;
}

export function cacheStore(): CacheStore | undefined {
  return active;
}

/** Where cache files live: `ASTPACK_CACHE_DIR`, else the platform's user cache directory. */
export function defaultCacheDir(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  if (env.ASTPACK_CACHE_DIR) return env.ASTPACK_CACHE_DIR;
  if (platform === 'win32') return join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'astpack', 'Cache');
  if (platform === 'darwin') return join(homedir(), 'Library', 'Caches', 'astpack');
  return join(env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'astpack');
}

/** Files larger than this are not loaded (a corrupt or runaway cache must not stall a run). */
const MAX_FILE_BYTES = 512 * 1024 * 1024;

type Entries = Record<string, Record<string, unknown>>;

let fingerprintValue: string | undefined;

/**
 * Identifies the code and grammars that produced cached entries: the version, the grammar
 * manifest and the modification times of the transform code (so a development build that
 * changes how files are transformed doesn't reuse old results).
 */
export function fingerprint(): string {
  if (fingerprintValue) return fingerprintValue;
  const hash = createHash('sha1').update(VERSION);
  const here = fileURLToPath(new URL('..', import.meta.url));
  try {
    hash.update(readFileSync(fileURLToPath(new URL('../../grammars/manifest.json', import.meta.url))));
  } catch {
    // Grammars missing: parsing will fail loudly elsewhere.
  }
  for (const dir of ['engine', 'languages', 'security']) {
    try {
      for (const name of readdirSync(join(here, dir)).sort()) hash.update(`${name}:${statSync(join(here, dir, name)).mtimeMs}`);
    } catch {
      // Bundled or relocated build: the version alone identifies it.
    }
  }
  fingerprintValue = hash.digest('hex').slice(0, 16);
  return fingerprintValue;
}

interface CacheFile {
  version: string;
  entries: Entries;
}

/** A cache file for one project root, loaded eagerly and written back with `save()`. */
export class FileCacheStore implements CacheStore {
  private readonly loaded: Entries;
  /** Entries read or written this session: the ones `save()` keeps. */
  private readonly used: Entries = {};
  private dirty = false;
  readonly path: string;

  constructor(root: string, dir = defaultCacheDir()) {
    this.path = join(dir, `${createHash('sha1').update(root).digest('hex').slice(0, 16)}.json.gz`);
    this.loaded = this.load();
  }

  private load(): Entries {
    try {
      if (statSync(this.path).size > MAX_FILE_BYTES) return {};
      const file = JSON.parse(gunzipSync(readFileSync(this.path)).toString('utf8')) as CacheFile;
      // Another version may transform differently: start afresh.
      return file.version === fingerprint() && file.entries && typeof file.entries === 'object' ? file.entries : {};
    } catch {
      return {};
    }
  }

  get<T>(namespace: string, key: string): T | undefined {
    const value = this.used[namespace]?.[key] ?? this.loaded[namespace]?.[key];
    if (value === undefined) return undefined;
    const used = (this.used[namespace] ??= {});
    if (!(key in used)) {
      used[key] = value;
      // Dropping entries the run didn't touch is a change worth saving.
      this.dirty = true;
    }
    return value as T;
  }

  set(namespace: string, key: string, value: unknown): void {
    (this.used[namespace] ??= {})[key] = value;
    this.dirty = true;
  }

  /** Write the entries used this session. Failures are ignored: the cache is an optimisation. */
  save(): void {
    if (!this.dirty && Object.keys(this.used).length === Object.keys(this.loaded).length) return;
    try {
      const dir = join(this.path, '..');
      mkdirSync(dir, { recursive: true });
      const tmp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(tmp, gzipSync(JSON.stringify({ version: fingerprint(), entries: this.used } satisfies CacheFile), { level: 1 }));
      renameSync(tmp, this.path);
      this.dirty = false;
      pruneStale(dir);
    } catch {
      // Read-only home, full disk, …: run without persisting.
    }
  }
}

/** Cache files of projects not packed for this long are deleted. */
const STALE_MS = 30 * 24 * 60 * 60 * 1000;

function pruneStale(dir: string): void {
  const cutoff = Date.now() - STALE_MS;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json.gz')) continue;
    const path = join(dir, name);
    try {
      if (statSync(path).mtimeMs < cutoff) rmSync(path, { force: true });
    } catch {
      // Removed concurrently.
    }
  }
}

/** Number and total size of cache files. */
export function cacheInfo(dir = defaultCacheDir()): { dir: string; files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json.gz')) continue;
      files++;
      bytes += statSync(join(dir, name)).size;
    }
  } catch {
    // No cache yet.
  }
  return { dir, files, bytes };
}

/**
 * Open the cache file for a project (`identity` is its root, or a stable name for a remote
 * clone). Returns `undefined` when caching is disabled with `ASTPACK_NO_CACHE`.
 */
export function openCache(identity: string, env: NodeJS.ProcessEnv = process.env): FileCacheStore | undefined {
  if (env.ASTPACK_NO_CACHE && env.ASTPACK_NO_CACHE !== '0') return undefined;
  return new FileCacheStore(identity, defaultCacheDir(env));
}

/** Delete every cache file. Returns the directory that was cleared. */
export function clearCache(dir = defaultCacheDir()): string {
  rmSync(dir, { recursive: true, force: true });
  return dir;
}
