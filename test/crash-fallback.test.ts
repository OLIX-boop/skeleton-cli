import { describe, expect, it, vi } from 'vitest';

// Simulate a grammar crashing mid-parse.
vi.mock('../src/engine/skeleton.js', () => ({
  skeletonize: vi.fn(async () => {
    throw new Error('The typescript parser crashed: boom');
  }),
}));

const { transformFile } = await import('../src/engine/transform.js');

describe('parser crash fallback', () => {
  it('falls back to raw content for plain source files', async () => {
    const out = await transformFile('a.ts', 'export const a = 1;\n', { mode: 'skeleton' });
    expect(out).toMatchObject({ content: 'export const a = 1;\n', strategy: 'full', parseErrors: true });
  });

  it('falls back for embedded formats too', async () => {
    const src = '<script lang="ts">function f() { return 1; }</script>\n<p>hi</p>\n';
    const out = await transformFile('A.vue', src, { mode: 'skeleton' });
    expect(out).toMatchObject({ content: src, strategy: 'full', parseErrors: true });
    expect(out.language?.id).toBe('vue');
  });
});
