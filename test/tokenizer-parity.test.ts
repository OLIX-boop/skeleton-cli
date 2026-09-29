import { get_encoding } from 'tiktoken';
import { describe, expect, it } from 'vitest';
import { TokenCounter } from '../src/tokens/index.js';

const samples = [
  'export function add(a: number, b: number): number { /* ... */ }\n',
  'def f():\n    """Docs with ünïcödé and emoji 🎉."""\n    ...\n',
  '<|endoftext|> special-looking <|fim_prefix|> text',
  '   \t\n\n  mixed    whitespace\r\n',
  '中文字符和日本語のテキスト',
  'x'.repeat(5000),
  Array.from({ length: 200 }, (_, i) => `const value${i} = compute(${i}) * 0x${i.toString(16)};`).join('\n'),
];

describe('token counts match tiktoken', () => {
  for (const encoding of ['cl100k_base', 'o200k_base'] as const) {
    it(encoding, () => {
      const reference = get_encoding(encoding);
      const counter = new TokenCounter();
      try {
        for (const text of samples) expect(counter.count(text, encoding), text.slice(0, 40)).toBe(reference.encode(text, [], []).length);
      } finally {
        reference.free();
      }
    });
  }
});
