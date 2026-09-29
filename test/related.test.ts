import { afterEach, describe, expect, it } from 'vitest';
import { fitToBudget } from '../src/budget.js';
import { relatedFiles } from '../src/deps.js';
import { render as renderAs } from '../src/output/index.js';
import { TokenCounter } from '../src/tokens/index.js';
import { pack } from '../src/pack.js';
import { makeTree } from './fixtures.js';

const body = (name: string) => `export function ${name}(): number {\n${'  const x = 1;\n'.repeat(20)}  return x;\n}\n`;

// app -> service -> db; cli -> app; util is unrelated.
const tree = {
  'src/app.ts': `import { serve } from './service';\n${body('app')}`,
  'src/service.ts': `import { query } from './db';\n${body('serve')}`,
  'src/db.ts': body('query'),
  'src/cli.ts': `import { app } from './app';\n${body('cli')}`,
  'src/util.ts': body('util'),
};

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

async function packed(related: number) {
  const t = await makeTree(tree);
  cleanup = t.cleanup;
  const result = await pack(t.root, { focus: ['src/app.ts'], cwd: t.root, related });
  const by = (p: string) => result.files.find((f) => f.path === p)!;
  return { result, by };
}

describe('relatedFiles', () => {
  const graph = new Map([
    ['a', ['b']],
    ['b', ['c']],
    ['d', ['a']],
  ]);

  it('walks imports and importers up to the given depth', () => {
    expect([...relatedFiles(graph, ['a'], 1)].sort()).toEqual(['b', 'd']);
    expect([...relatedFiles(graph, ['a'], 2)].sort()).toEqual(['b', 'c', 'd']);
    expect(relatedFiles(graph, ['a'], 0).size).toBe(0);
  });
});

describe('pack with related', () => {
  it('keeps direct imports and importers of focused files as full source', async () => {
    const { by } = await packed(1);
    expect(by('src/app.ts')).toMatchObject({ focused: true, strategy: 'full' });
    expect(by('src/app.ts').related).toBeUndefined();
    for (const p of ['src/service.ts', 'src/cli.ts']) expect(by(p)).toMatchObject({ focused: true, related: true, strategy: 'full' });
    for (const p of ['src/db.ts', 'src/util.ts']) expect(by(p)).toMatchObject({ focused: false, strategy: 'skeleton' });
  });

  it('follows more hops with a larger depth', async () => {
    const { by } = await packed(2);
    expect(by('src/db.ts')).toMatchObject({ focused: true, related: true });
    expect(by('src/util.ts').focused).toBe(false);
  });

  it('compresses related files only after every other file, and never the targets', async () => {
    const { result } = await packed(1);
    const render = (r: typeof result) => renderAs('markdown', r, { projectName: 'p', tree: false });
    const counter = new TokenCounter();
    const appTokens = counter.count(result.files.find((f) => f.path === 'src/app.ts')!.content);
    counter.free();
    // Room for the target and a little more: related files must give way too.
    const report = await fitToBudget(result, { maxTokens: appTokens + 250, render });
    const after = (p: string) => report.result.files.find((f) => f.path === p)!;
    expect(after('src/app.ts')).toMatchObject({ focused: true, strategy: 'full' });
    // Unrelated files went through every level (a final backfill may restore their outline).
    for (const p of ['src/util.ts', 'src/db.ts']) expect(['outline', 'omitted']).toContain(after(p).strategy);
    const compressed = ['src/service.ts', 'src/cli.ts'].map(after).filter((f) => f.strategy !== 'full');
    expect(compressed.length).toBeGreaterThan(0);
    for (const f of compressed) {
      expect(f.focused).toBe(false);
      expect(f.related).toBeUndefined();
    }
  });
});
