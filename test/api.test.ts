import { afterEach, describe, expect, it } from 'vitest';
import * as api from '../src/index.js';
import { computeStats, fitToBudget, pack, render, skeletonize } from '../src/index.js';
import { makeTree } from './fixtures.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

describe('public API', () => {
  it('exports everything the README documents', () => {
    for (const name of [
      'pack',
      'render',
      'skeletonize',
      'fitToBudget',
      'computeStats',
      'walk',
      'transformFile',
      'splitPack',
      'redactSecrets',
      'LANGUAGES',
      'languageForPath',
      'AstpackMcpServer',
      'VERSION',
    ]) {
      expect(api, name).toHaveProperty(name);
    }
  });

  it('runs the README example', async () => {
    const t = await makeTree({ 'src/billing/invoice.ts': 'export function total(xs: number[]) {\n  return xs.reduce((a, b) => a + b, 0);\n}\n', 'src/x.ts': 'export const f = () => {\n  return 1;\n};\n' });
    cleanups.push(t.cleanup);
    const { code } = await skeletonize('function f() { return 1 }', 'typescript');
    expect(code).toBe('function f() { /* ... */ }');
    const result = await pack(t.root, { focus: ['src/billing'], comments: 'docs', cwd: t.root });
    const document = render('markdown', result, { projectName: 'my-app' });
    expect(document).toContain('return xs.reduce');
    const { document: fitted, tokens } = await fitToBudget(result, { maxTokens: 100_000, render: (r) => render('xml', r, { projectName: 'my-app' }) });
    expect(fitted).toMatch(/^<project/);
    expect(tokens).toBeGreaterThan(0);
    const stats = computeStats(result, document, { models: ['claude-sonnet-5.5', 'gpt-4o'] });
    expect(stats.tokens.cl100k_base.output).toBeGreaterThan(0);
    expect(stats.costs).toHaveLength(2);
  });
});
