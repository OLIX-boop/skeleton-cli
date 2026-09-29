import { afterEach, describe, expect, it } from 'vitest';
import { pack } from '../src/pack.js';
import { search, stem, topHits, words } from '../src/search.js';
import { makeTree } from './fixtures.js';

describe('words', () => {
  it('splits identifiers and stems plural and verb forms', () => {
    expect(words('parseInvoicePDF parse_invoices HTTPServer')).toEqual(['pars', 'invoic', 'pdf', 'pars', 'invoic', 'http', 'server']);
    expect(words('the and of 42 x')).toEqual([]);
    expect(stem('parsing')).toBe('pars');
    expect(stem('policies')).toBe('policy');
    expect(stem('keys')).toBe('key');
    expect(stem('user')).toBe('user');
  });
});

describe('search', () => {
  const docs = [
    { path: 'src/billing/invoice.ts', text: 'export function renderInvoicePdf(invoice: Invoice) {}' },
    { path: 'src/billing/tax.ts', text: 'export function computeTax(amount: number) {}' },
    { path: 'src/auth/login.ts', text: 'export function login(user: User) {}' },
    { path: 'README.md', text: 'Invoices are rendered as PDF. Invoice invoice invoice pdf pdf.', weight: 0.4 },
  ];

  it('ranks files by relevance, weighting paths and distinct words', () => {
    const hits = search(docs, 'Invoice PDF rendering');
    expect(hits[0]!.path).toBe('src/billing/invoice.ts');
    expect(hits[0]!.matched).toEqual(['invoice', 'pdf', 'rendering']);
    expect(hits.map((h) => h.path)).not.toContain('src/auth/login.ts');
  });

  it('returns nothing for empty or stop-word-only queries', () => {
    expect(search(docs, '')).toEqual([]);
    expect(search(docs, 'the of and')).toEqual([]);
  });

  it('limits hits and drops the long tail', () => {
    const hits = [
      { path: 'a', score: 10, matched: [] },
      { path: 'b', score: 5, matched: [] },
      { path: 'c', score: 1, matched: [] },
    ];
    expect(topHits(hits, 5).map((h) => h.path)).toEqual(['a', 'b']);
    expect(topHits(hits, 1).map((h) => h.path)).toEqual(['a']);
    expect(topHits(hits, -1)).toEqual([]);
  });
});

describe('pack with query', () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it('focuses the best-matching files and reports them', async () => {
    const t = await makeTree({
      'src/invoice.ts': 'export function renderInvoice(): string {\n  return "pdf";\n}\n',
      'src/login.ts': 'export function login(): boolean {\n  return true;\n}\n',
    });
    cleanup = t.cleanup;
    const result = await pack(t.root, { query: 'render the invoice' });
    const by = (p: string) => result.files.find((f) => f.path === p)!;
    expect(by('src/invoice.ts')).toMatchObject({ focused: true, matched: true, strategy: 'full' });
    expect(by('src/login.ts')).toMatchObject({ focused: false, strategy: 'skeleton' });
    expect(result.queryHits?.map((h) => h.path)).toEqual(['src/invoice.ts']);
  });
});
