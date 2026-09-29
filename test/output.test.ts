import { describe, expect, it } from 'vitest';
import { renderTree } from '../src/output/index.js';
import { codeFence } from '../src/output/common.js';
import { formatBytes, formatPercent, formatUsd, parseSize } from '../src/cli/format.js';
import { table } from '../src/cli/table.js';
import { computeStats } from '../src/tokens/index.js';
import type { PackResult } from '../src/pack.js';

describe('renderTree', () => {
  it('renders nested paths with files before directories and notes', () => {
    const tree = renderTree(['src/b.ts', 'README.md', 'src/lib/a.ts', 'src/a.ts'], new Map([['src/a.ts', '[focus]']]));
    expect(tree).toBe(`.
├── README.md
└── src/
    ├── a.ts  [focus]
    ├── b.ts
    └── lib/
        └── a.ts`);
  });
});

describe('codeFence', () => {
  it('outgrows backtick runs in the content', () => {
    expect(codeFence('plain')).toBe('```');
    expect(codeFence('a ```js\nx\n``` b')).toBe('````');
    expect(codeFence('`````')).toBe('``````');
  });
});

describe('formatting', () => {
  it('formats and parses sizes', () => {
    expect(parseSize('500')).toBe(500);
    expect(parseSize('2kb')).toBe(2048);
    expect(parseSize('1.5MB')).toBe(1572864);
    expect(parseSize('1m')).toBe(1048576);
    expect(() => parseSize('big')).toThrow();
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(50 * 1024 * 1024)).toBe('50 MB');
  });

  it('formats money and percentages', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(0.0012)).toBe('$0.0012');
    expect(formatUsd(1.234)).toBe('$1.23');
    expect(formatPercent(0.684)).toBe('68%');
    expect(formatPercent(0.054)).toBe('5.4%');
  });

  it('draws aligned tables', () => {
    expect(table([['a', '1'], ['bbb', '22']], ['left', 'right'], ['k', 'v'])).toBe(`┌─────┬────┐
│ k   │  v │
├─────┼────┤
│ a   │  1 │
│ bbb │ 22 │
└─────┴────┘`);
  });
});

describe('computeStats', () => {
  const result: PackResult = {
    root: '/x',
    mode: 'skeleton',
    focusOutsideRoot: [],
    skipped: [
      { path: 'node_modules/', reason: 'ignored' },
      { path: 'a.png', reason: 'ignored' },
      { path: 'big.bin', reason: 'binary' },
    ],
    files: [
      {
        path: 'a.ts',
        size: 100,
        language: 'typescript',
        fence: 'ts',
        strategy: 'skeleton',
        focused: false,
        content: 'function f() { /* ... */ }\n',
        original: 'function f() {\n  const values = [1, 2, 3, 4, 5, 6, 7, 8, 9];\n  return values.map((v) => v * 2).filter(Boolean);\n}\n',
        strippedBodies: 1,
        parseErrors: false,
      },
      {
        path: 'README.md',
        size: 10,
        fence: 'markdown',
        strategy: 'full',
        focused: false,
        content: '# Hi\n',
        original: '# Hi\n',
        strippedBodies: 0,
        parseErrors: true,
      },
    ],
  };

  it('computes totals, savings and costs', () => {
    const output = result.files.map((f) => f.content).join('');
    const stats = computeStats(result, output, { models: ['gpt-4o', 'claude-3.5-sonnet', 'nope'] });
    expect(stats.filesIncluded).toBe(2);
    expect(stats.entriesScanned).toBe(5);
    expect(stats.skipped).toEqual({ ignored: 2, binary: 1 });
    expect(stats.byStrategy).toEqual({ skeleton: 1, full: 1 });
    expect(stats.strippedBodies).toBe(1);
    expect(stats.parseErrorFiles).toEqual(['README.md']);
    expect(stats.tokens.cl100k_base.baseline).toBeGreaterThan(stats.tokens.cl100k_base.output);
    expect(stats.savedRatio).toBeGreaterThan(0.5);
    expect(stats.costs.map((c) => c.model.id)).toEqual(['gpt-4o', 'claude-3.5-sonnet']);
    const gpt = stats.costs[0]!;
    expect(gpt.usd).toBeCloseTo((gpt.tokens / 1e6) * 2.5, 10);
    expect(stats.files[0]!.path).toBe('a.ts');
  });

  it('handles special-token lookalikes in source', () => {
    const r = { ...result, files: [{ ...result.files[1]!, content: '<|endoftext|>', original: '<|endoftext|>' }] };
    expect(computeStats(r, '<|endoftext|>').tokens.cl100k_base.output).toBeGreaterThan(1);
  });
});
