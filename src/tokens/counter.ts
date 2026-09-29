import { get_encoding, type Tiktoken } from 'tiktoken';
import type { EncodingName } from './pricing.js';

/**
 * Lazily-initialised tiktoken encoders. Call `free()` when done: the encoders live in WASM
 * memory that the JS garbage collector does not reclaim.
 */
export class TokenCounter {
  private readonly encoders = new Map<EncodingName, Tiktoken>();

  count(text: string, encoding: EncodingName = 'cl100k_base'): number {
    if (!text) return 0;
    let enc = this.encoders.get(encoding);
    if (!enc) {
      enc = get_encoding(encoding);
      this.encoders.set(encoding, enc);
    }
    // Treat special-token lookalikes (e.g. "<|endoftext|>" in source) as plain text.
    return enc.encode(text, [], []).length;
  }

  free(): void {
    for (const enc of this.encoders.values()) enc.free();
    this.encoders.clear();
  }
}
