import { afterEach, describe, expect, it } from 'vitest';
import { fitToBudget } from '../src/budget.js';
import { render } from '../src/output/index.js';
import { pack, type PackResult } from '../src/pack.js';
import { TokenCounter } from '../src/tokens/index.js';
import { makeTree } from './fixtures.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

function fn(name: string, lines: number): string {
  const body = Array.from({ length: lines }, (_, i) => `  const v${i} = compute(${i}, "${name}") * ${i};`).join('\n');
  return `// Helper ${name}.\n/** Does ${name}. */\nexport function ${name}(input: number): number {\n${body}\n  return input;\n}\n`;
}

async function project() {
  const t = await makeTree({
    'src/core.ts': fn('core', 60) + fn('coreTwo', 60),
    'src/util.ts': fn('util', 40),
    'src/focus.ts': fn('focused', 30),
    'src/core.test.ts': fn('testCore', 80),
    'docs/guide.md': '# Guide\n\n' + 'Some prose about the project. '.repeat(200),
    'README.md': '# Demo\n',
  });
  cleanups.push(t.cleanup);
  return t.root;
}

const md = (r: PackResult) => render('markdown', r, { projectName: 'demo' });
const count = (s: string) => {
  const c = new TokenCounter();
  try {
    return c.count(s);
  } finally {
    c.free();
  }
};

describe('fitToBudget', () => {
  it('does nothing when the pack already fits', async () => {
    const root = await project();
    const result = await pack(root, { mode: 'full' });
    const report = await fitToBudget(result, { maxTokens: 1_000_000, render: md });
    expect(report.fits).toBe(true);
    expect(report.changes).toEqual([]);
    expect(report.tokens).toBe(report.initialTokens);
  });

  it('skeletonizes the largest files first before touching comments', async () => {
    const root = await project();
    const result = await pack(root, { mode: 'full' });
    const full = count(md(result));
    const report = await fitToBudget(result, { maxTokens: Math.round(full * 0.7), render: md });
    expect(report.fits).toBe(true);
    expect(report.tokens).toBe(count(report.document));
    expect(report.changes.every((c) => c.from === 'full' && c.to === 'skeleton')).toBe(true);
    // core.ts has the biggest bodies, so it is compressed first.
    expect(report.changes[0]!.path).toBe('src/core.ts');
    expect(report.result.files.find((f) => f.path === 'src/util.ts')!.strategy).toBe('full');
  });

  it('omits tests and docs before code, and never touches focused files', async () => {
    const root = await project();
    const result = await pack(root, { mode: 'skeleton', focus: ['src/focus.ts'], cwd: root });
    const focusedBefore = result.files.find((f) => f.path === 'src/focus.ts')!.content;
    const report = await fitToBudget(result, { maxTokens: 900, render: md });
    expect(report.fits).toBe(true);
    const byPath = Object.fromEntries(report.result.files.map((f) => [f.path, f]));
    expect(byPath['src/focus.ts']!.content).toBe(focusedBefore);
    const omitted = report.changes.filter((c) => c.to === 'omitted').map((c) => c.path);
    expect(omitted).toContain('docs/guide.md');
    expect(omitted).not.toContain('src/core.ts');
    expect(byPath['src/core.ts']!.strategy).not.toBe('omitted');
    expect(report.document).toContain('[omitted]');
    expect(report.document).not.toContain('Some prose about the project');
  });

  it('strips comments as an intermediate step', async () => {
    const root = await project();
    const result = await pack(root, { mode: 'skeleton', ignore: ['docs/', '*.test.ts', 'README.md'] });
    const skeleton = count(md(result));
    const report = await fitToBudget(result, { maxTokens: skeleton - 15, render: md });
    expect(report.fits).toBe(true);
    expect(report.changes.some((c) => c.to === 'docs' || c.to === 'bare')).toBe(true);
    expect(report.changes.every((c) => c.to !== 'omitted')).toBe(true);
  });

  it('uses outlines before omitting code files', async () => {
    const many = (prefix: string) =>
      Array.from({ length: 40 }, (_, i) => `export function ${prefix}${i}(input: number): number {\n  return input * ${i};\n}\n`).join('');
    const t = await makeTree({ 'src/a.ts': many('a'), 'src/b.ts': many('b') });
    cleanups.push(t.cleanup);
    const result = await pack(t.root, { mode: 'skeleton' });
    const skeleton = count(md(result));
    const report = await fitToBudget(result, { maxTokens: skeleton - 150, render: md });
    expect(report.fits).toBe(true);
    expect(report.changes.map((c) => c.to)).toContain('outline');
    expect(report.changes.every((c) => c.to !== 'omitted')).toBe(true);
    expect(report.document).toContain('[outline]');
  });

  it('reports when the budget cannot be met', async () => {
    const root = await project();
    const result = await pack(root, { mode: 'full', focus: ['src'], cwd: root });
    const report = await fitToBudget(result, { maxTokens: 50, render: md });
    expect(report.fits).toBe(false);
    expect(report.focusTokens).toBeGreaterThan(50);
  });
});
