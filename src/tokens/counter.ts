import { createRequire } from 'node:module';
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
    return encoder(encoding).countTokens(text, NO_SPECIAL);
  }

  /** Kept for API compatibility; the pure-JS encoders need no explicit cleanup. */
  free(): void {}
}
