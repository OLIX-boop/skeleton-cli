import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
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
const counts = new LruCache<string, number>(50_000);
/** Below this size tokenizing is cheap enough that hashing doesn't pay off. */
const CACHE_MIN_LENGTH = 2_000;

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
    const key = `${encoding}:${createHash('sha1').update(text).digest('base64')}`;
    let n = counts.get(key);
    if (n === undefined) {
      n = encoder(encoding).countTokens(text, NO_SPECIAL);
      counts.set(key, n);
    }
    return n;
  }

  /** Kept for API compatibility; the pure-JS encoders need no explicit cleanup. */
  free(): void {}
}
