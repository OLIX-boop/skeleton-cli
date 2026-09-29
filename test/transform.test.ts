import { describe, expect, it } from 'vitest';
import { transformFile, truncate } from '../src/engine/transform.js';

describe('transformFile', () => {
  it('skeletonizes supported languages in skeleton mode', async () => {
    const out = await transformFile('src/a.py', 'def f():\n    return 1\n', { mode: 'skeleton' });
    expect(out).toMatchObject({ content: 'def f():\n    ...\n', strategy: 'skeleton', strippedBodies: 1 });
    expect(out.language?.id).toBe('python');
  });

  it('includes files verbatim in full mode', async () => {
    const src = 'function f() { return 1; }';
    const out = await transformFile('a.ts', src, { mode: 'full' });
    expect(out).toMatchObject({ content: src, strategy: 'full', strippedBodies: 0 });
  });

  it('keeps small unsupported files verbatim', async () => {
    const out = await transformFile('README.md', '# Hi\n', { mode: 'skeleton' });
    expect(out).toMatchObject({ content: '# Hi\n', strategy: 'full' });
    expect(out.language).toBeUndefined();
  });

  it('truncates large unsupported files at the line limit', async () => {
    const src = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n') + '\n';
    const out = await transformFile('data.yaml', src, { mode: 'skeleton', fallback: { maxLines: 3 } });
    expect(out.strategy).toBe('truncated');
    expect(out.content).toBe('line 0\nline 1\nline 2\n... [truncated: 7 more lines, 49 chars]\n');
  });

  it('reports parse errors', async () => {
    const out = await transformFile('a.go', 'package x\nfunc (', { mode: 'skeleton' });
    expect(out.parseErrors).toBe(true);
  });
});

describe('truncate', () => {
  it('cuts at the character limit on a line boundary', () => {
    expect(truncate('aaaa\nbbbb\ncccc\n', { maxLines: 100, maxChars: 12 })).toEqual({
      content: 'aaaa\nbbbb\n... [truncated: 1 more line, 5 chars]\n',
      truncated: true,
    });
  });

  it('hard-cuts a single long line', () => {
    const out = truncate('x'.repeat(50), { maxLines: 100, maxChars: 10 });
    expect(out.content).toBe(`${'x'.repeat(10)}\n... [truncated: 1 more line, 40 chars]\n`);
  });

  it('leaves content within limits alone', () => {
    expect(truncate('a\nb\n', { maxLines: 2, maxChars: 100 })).toEqual({ content: 'a\nb\n', truncated: false });
  });
});
