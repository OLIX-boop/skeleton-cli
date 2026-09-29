import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { cacheStore } from '../cache/store.js';
import { activePool, WorkerFailure } from '../parallel/pool.js';
import { LruCache } from '../util/lru.js';
import type { EncodingName } from './pricing.js';

const require = createRequire(import.meta.url);

interface Encoder {
  countTokens(text: string, options?: { disallowedSpecial?: Set<string> }): number;
}

const encoders = new Map<EncodingName, Encoder>();

/** Load an encoding on first use (each rank table costs ~100 ms to load). */
function encoder(name: EncodingName): Encoder {
  let enc = encoders.get(name);
  if (!enc) {
    enc = require(`gpt-tokenizer/encoding/${name}`) as Encoder;
    encoders.set(name, enc);
  }
  return enc;
}

/** Counts of recently seen texts; hashing is ~100x cheaper than tokenizing. */
const counts = new LruCache<string, number>(250_000);
/** Below this size tokenizing is cheap enough that hashing doesn't pay off. */
const CACHE_MIN_LENGTH = 2_000;

/** Aim for chunks of about this many characters when splitting long texts. */
const CHUNK_TARGET = 16 * 1024;

/** Count without caching (what worker threads run). */
export function countUncached(text: string, encoding: EncodingName): number {
  return encoder(encoding).countTokens(text, NO_SPECIAL);
}

function keyFor(text: string, encoding: EncodingName): string {
  return `${encoding}:${createHash('sha1').update(text).digest('base64')}`;
}

/** The pieces `count` looks up in the caches for `text`. */
function pieces(text: string): string[] {
  if (text.length < CACHE_MIN_LENGTH) return [];
  return text.length <= CHUNK_TARGET * 2 ? [text] : [...chunks(text)];
}

function countCached(text: string, encoding: EncodingName): number {
  const key = keyFor(text, encoding);
  let n = counts.get(key);
  const store = cacheStore();
  if (n !== undefined) {
    if (store && store.get('tokens', key) === undefined) store.set('tokens', key, n);
    return n;
  }
  n = store?.get<number>('tokens', key);
  if (n === undefined) {
    n = encoder(encoding).countTokens(text, NO_SPECIAL);
    store?.set('tokens', key, n);
  }
  counts.set(key, n);
  return n;
}

/**
 * Split a long text where no token can span the cut, so the chunk counts add up to the
 * count of the whole text. Both encodings pre-split text with a regex before merging, and
 * no pre-token crosses a line break followed by a character other than whitespace or `/`
 * (o200k attaches `/` after trailing newlines to punctuation). Cut points are chosen from
 * the text around them, not from offsets, so an edit early in a document leaves later
 * chunks, and their cached counts, unchanged.
 */
export function* chunks(text: string): Generator<string> {
  let start = 0;
  let pos = text.indexOf('\n', start + CHUNK_TARGET / 2);
  while (pos !== -1 && pos + 1 < text.length) {
    const next = text.charCodeAt(pos + 1);
    const cuttable = next !== 0x2f && !/\s/.test(text[pos + 1]!);
    const length = pos + 1 - start;
    // A cheap rolling choice: cut where the next line starts with a "rare" character code
    // sum, or unconditionally once a chunk grows past four times the target.
    if (cuttable && (length >= CHUNK_TARGET * 4 || (length >= CHUNK_TARGET / 2 && lineSignature(text, pos + 1) % 8 === 0))) {
      yield text.slice(start, pos + 1);
      start = pos + 1;
      pos = text.indexOf('\n', start + CHUNK_TARGET / 2);
    } else {
      pos = text.indexOf('\n', pos + 1);
    }
  }
  if (start < text.length) yield text.slice(start);
}

function lineSignature(text: string, from: number): number {
  let h = 0;
  const end = Math.min(text.length, from + 24);
  for (let i = from; i < end; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x0a) break;
    h = (h * 31 + c) | 0;
  }
  return h >>> 0;
}

// Treat special-token lookalikes (e.g. "<|endoftext|>" in source) as plain text.
const NO_SPECIAL = { disallowedSpecial: new Set<string>() };

/**
 * Counts tokens with OpenAI's BPE encodings. Uses `gpt-tokenizer`, a pure-JS port of
 * `tiktoken` that produces identical counts (checked in the test suite) without a WASM
 * module, so it runs fast under the CLI's Liftoff-only WebAssembly setting.
 */
export class TokenCounter {
  count(text: string, encoding: EncodingName = 'cl100k_base'): number {
    if (!text) return 0;
    if (text.length < CACHE_MIN_LENGTH) return encoder(encoding).countTokens(text, NO_SPECIAL);
    if (text.length <= CHUNK_TARGET * 2) return countCached(text, encoding);
    let total = 0;
    for (const chunk of chunks(text)) total += countCached(chunk, encoding);
    return total;
  }

  /**
   * Count `texts` ahead of time on worker threads (when a pool is enabled), so later `count`
   * calls on them, or on documents made of them, are cache hits. A no-op without a pool.
   */
  async prefetch(texts: readonly string[], encodings: readonly EncodingName[] = ['cl100k_base']): Promise<void> {
    const pool = activePool();
    if (!pool) return;
    const store = cacheStore();
    for (const encoding of encodings) {
      const todo = new Map<string, string>();
      for (const text of texts) {
        for (const piece of pieces(text)) {
          const key = keyFor(piece, encoding);
          if (todo.has(key) || counts.get(key) !== undefined) continue;
          const stored = store?.get<number>('tokens', key);
          if (stored !== undefined) counts.set(key, stored);
          else todo.set(key, piece);
        }
      }
      // Batches of ~128 KiB keep every thread busy without huge messages.
      const batches: [string, string][][] = [[]];
      let size = 0;
      for (const entry of todo) {
        if (size > 128 * 1024) {
          batches.push([]);
          size = 0;
        }
        batches.at(-1)!.push(entry);
        size += entry[1].length;
      }
      // Workers and this thread (otherwise idle, awaiting them) pull batches from one queue.
      let next = 0;
      const record = (batch: [string, string][], results: number[]) =>
        batch.forEach(([key], i) => {
          counts.set(key, results[i]!);
          store?.set('tokens', key, results[i]!);
        });
      const remote = async () => {
        for (let batch = batches[next++]; batch; batch = batches[next++]) {
          if (!batch.length) continue;
          try {
            record(batch, await pool.run<number[]>({ type: 'count', encoding, texts: batch.map(([, t]) => t) }));
          } catch (error) {
            // Counted inline later instead.
            if (!(error instanceof WorkerFailure)) throw error;
          }
        }
      };
      const local = async () => {
        for (let batch = batches[next++]; batch; batch = batches[next++]) {
          record(batch, batch.map(([, t]) => countUncached(t, encoding)));
          // Let worker results in between.
          await new Promise((r) => setImmediate(r));
        }
      };
      await Promise.all([...Array.from({ length: pool.size }, remote), local()]);
    }
  }

  /** Kept for API compatibility; the pure-JS encoders need no explicit cleanup. */
  free(): void {}
}
