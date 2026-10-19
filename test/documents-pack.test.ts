import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { condenseDocument, outlineDocument, parsePages, selectPages, selectSections } from '../src/documents/condense.js';
import { condenseData } from '../src/documents/data.js';
import { readDocument } from '../src/documents/read.js';
import { AstpackMcpServer } from '../src/mcp/server.js';
import { pack } from '../src/pack.js';
import { render } from '../src/output/index.js';
import { run } from '../src/cli/program.js';
import { docx, ink, para, pdf, text } from './documents-fixtures.js';
import { makeTree } from './fixtures.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

async function tree(files: Record<string, string | Uint8Array>) {
  const t = await makeTree(files);
  cleanups.push(t.cleanup);
  return t.root;
}

const sentence = (n: number) => `Sentence ${n} explains one more detail of the plan in plain words.`;
const long = (n: number, from = 0) => Array.from({ length: n }, (_, i) => sentence(from + i)).join(' ');

/** A long Markdown document: three sections of several paragraphs each. */
const markdown = ['# Plan', long(3), '## Budget', long(6), long(6, 10), long(6, 20), '## Risks', long(4), long(4, 30), '| a | b |\n| --- | --- |\n' + Array.from({ length: 20 }, (_, i) => `| ${i} | x |`).join('\n')].join('\n\n') + '\n';

describe('condensing documents', () => {
  it('keeps headings, the lead of each section and notes; summarises the rest', () => {
    const out = condenseDocument(`${markdown.repeat(4)}`);
    expect(out.length).toBeLessThan(markdown.length * 4 * 0.5);
    expect(out).toContain('## Budget\n\nSentence 0 explains');
    expect(out).toMatch(/\[… 2 more paragraphs, \d+ words\]/);
    expect(out).toContain('[… 17 more rows]');
  });

  it('leaves small documents whole', () => {
    expect(condenseDocument('# A\n\nshort\n')).toBe('# A\n\nshort\n');
  });

  it('outlines headings with section sizes and pages', () => {
    const doc = `<!-- page 1 -->\n\n# Plan\n\nIntro text here.\n\n<!-- page 2 -->\n\n## Budget\n\n${long(2)}\n\n[page 2: also has handwriting or drawings, not in the text above]\n`;
    expect(outlineDocument(doc)).toBe('Plan [p.1] (3 words)\n  Budget [p.2] (24 words)\n[page 2: also has handwriting or drawings, not in the text above]\n');
  });

  it('outlines documents without headings page by page', () => {
    expect(outlineDocument('<!-- page 1 -->\n\nFirst page words.\n\n<!-- page 2 -->\n\n[page 2: handwriting or drawing, no text layer]\n')).toBe(
      'p.1: First page words. (3 words)\n[page 2: handwriting or drawing, no text layer]\np.2: (0 words)\n',
    );
  });

  it('selects sections by heading and pages by number', () => {
    expect(selectSections(markdown, 'budget')).toMatch(/^## Budget\n\nSentence 0[\s\S]*Sentence 25[^\n]*\n$/);
    expect(selectSections(markdown, 'nothing')).toBeUndefined();
    expect(selectPages('<!-- page 1 -->\n\na\n\n<!-- page 2 -->\n\nb\n\n<!-- page 3 -->\n\nc\n', [2, 3])).toBe('<!-- page 2 -->\n\nb\n\n<!-- page 3 -->\n\nc\n');
    expect(parsePages('3,1-2, 7')).toEqual([1, 2, 3, 7]);
    expect(() => parsePages('2-x')).toThrow(/invalid/);
  });
});

describe('data files', () => {
  it('samples CSV rows, keeping the header', () => {
    const csv = `id,name,score\n${Array.from({ length: 500 }, (_, i) => `${i},user${i},${i % 7}`).join('\n')}\n`;
    const out = condenseData('data/scores.csv', csv)!;
    expect(out.split('\n')[0]).toBe('id,name,score');
    expect(out).toContain('… [480 more rows, 500 in total] (3 columns)');
  });

  it('keeps the shape of large JSON, not small config files', () => {
    const json = JSON.stringify({ name: 'x', items: Array.from({ length: 2000 }, (_, i) => ({ id: i, tags: ['a', 'b'] })) });
    const out = JSON.parse(condenseData('items.json', json)!) as { items: unknown[] };
    expect(out.items).toHaveLength(4);
    expect(out.items[3]).toBe('… 1997 more items (2000 in total)');
    expect(condenseData('package.json', JSON.stringify({ scripts: { a: 'b' }, files: ['a', 'b', 'c', 'd'] }))).toBeUndefined();
  });

  it('describes SVG images', () => {
    const svg = `<svg width="24" height="24"><title>Logo</title><path d="${'M0 0 L1 1 '.repeat(800)}"/><text>ACME</text></svg>`;
    expect(condenseData('logo.svg', svg)).toBe('[SVG image 24×24, 8 KB: Logo]\nText: ACME\n');
  });
});

const notes = pdf([
  { content: text(72, 780, 20, 'Lecture 3') + ink(30) },
  { content: ink(36, 80, 700) },
  { content: '' },
]);

describe('reading documents', () => {
  it('shows small documents whole and large ones as an outline', async () => {
    const root = await tree({
      'small.docx': docx(para('Title', 'Title') + para('Body text.')),
      'big.docx': docx(para('Plan', 'Title') + para('Budget', 'Heading1') + Array.from({ length: 600 }, (_, i) => para(sentence(i))).join('')),
    });
    const small = await readDocument(join(root, 'small.docx'));
    expect(small.view).toBe('full');
    expect(small.text).toBe('[document: small.docx · DOCX · 6 tokens as text]\n\n# Title\n\nBody text.\n');
    const big = await readDocument(join(root, 'big.docx'));
    expect(big.view).toBe('outline');
    expect(big.tokens).toBeLessThan(150);
    expect(big.text).toMatch(/shown as an outline because the full text is [\d,]+ tokens/);
    expect(big.text).toContain('Plan (0 words)\n  Budget (7200 words)');
  });

  it('merges saved transcriptions into later reads', async () => {
    const root = await tree({ '.git/': '', 'notes/lecture.pdf': notes });
    const server = new AstpackMcpServer({ roots: [root] });
    const call = async (name: string, args: Record<string, unknown>) =>
      ((await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })) as { result: { content: { type: string; text?: string; data?: string }[]; structuredContent: Record<string, unknown>; isError?: boolean } }).result;

    const first = await call('read_document', { path: 'notes/lecture.pdf' });
    expect(first.content.filter((c) => c.type === 'image')).toHaveLength(2);
    expect(first.structuredContent).toMatchObject({ format: 'pdf', pages: 3, view: 'full', imagePages: [1, 2], pendingPages: [1, 2] });
    expect(first.content.at(-1)!.text).toContain('save_transcription');

    const saved = await call('save_transcription', { path: 'notes/lecture.pdf', pages: [{ page: 2, text: 'Entropy never decreases.' }] });
    expect(saved.isError).toBeUndefined();
    const stored = JSON.parse(await readFile(saved.structuredContent.file as string, 'utf8')) as { file: string; pages: Record<string, string> };
    expect(stored).toMatchObject({ file: 'lecture.pdf', pages: { 2: 'Entropy never decreases.' } });
    expect(saved.structuredContent.file).toContain(join(root, '.astpack', 'transcripts'));

    const second = await call('read_document', { path: 'notes/lecture.pdf', pages: '2' });
    expect(second.content.filter((c) => c.type === 'image')).toHaveLength(0);
    expect(second.content[0]!.text).toContain('[page 2: handwriting or drawing, transcribed]\n\nEntropy never decreases.');
    expect(second.content[0]!.text).toContain('1 page transcribed earlier');

    // Packing the project picks the transcription up too.
    const packed = await pack(root);
    expect(packed.files.find((f) => f.path === 'notes/lecture.pdf')!.content).toContain('Entropy never decreases.');
  });

  it('lists tools with the right annotations and rejects non-documents', async () => {
    const root = await tree({ 'a.ts': 'export const a = 1;\n' });
    const server = new AstpackMcpServer({ roots: [root] });
    const list = (await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })) as { result: { tools: { name: string; annotations: { readOnlyHint: boolean } }[] } };
    const byName = Object.fromEntries(list.result.tools.map((t) => [t.name, t.annotations.readOnlyHint]));
    expect(byName).toMatchObject({ read_document: true, save_transcription: false, pack_codebase: true });
    const res = (await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read_document', arguments: { path: 'a.ts' } } })) as { result: { isError: boolean; content: { text: string }[] } };
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0]!.text).toMatch(/not a supported document/);
  });
});

describe('packing documents', () => {
  it('includes documents converted to Markdown, condensed in skeleton mode', async () => {
    const root = await tree({
      'src/a.ts': 'export function a(): number {\n  return 1;\n}\n',
      'docs/spec.docx': docx(para('Spec', 'Title') + para('Overview', 'Heading1') + Array.from({ length: 150 }, (_, i) => para(sentence(i))).join('')),
      'docs/broken.pdf': 'not really a pdf',
      'scan.pdf': notes,
    });
    const result = await pack(root);
    const spec = result.files.find((f) => f.path === 'docs/spec.docx')!;
    expect(spec).toMatchObject({ language: 'docx', fence: 'markdown', strategy: 'skeleton' });
    expect(spec.content).toMatch(/^# Spec\n\n## Overview\n\nSentence 0 [^\n]*\n\n\[… 149 more paragraphs, \d+ words\]\n$/);
    expect(result.files.find((f) => f.path === 'scan.pdf')!.content).toContain('[page 2: handwriting or drawing, no text layer]');
    expect(result.skipped).toContainEqual(expect.objectContaining({ path: 'docs/broken.pdf', reason: 'unreadable' }));
    const document = render('markdown', result, { projectName: 'p' });
    expect(document).toContain('Documents (PDF, Office, e-book, e-mail) were converted to Markdown');

    const outlined = await pack(root, { mode: 'outline' });
    expect(outlined.files.find((f) => f.path === 'docs/spec.docx')!.content).toBe('Spec (0 words)\n  Overview (1800 words)\n');

    const without = await pack(root, { documents: false });
    expect(without.files.map((f) => f.path)).toEqual(['src/a.ts']);
  });

  it('never packs the .astpack folder', async () => {
    const root = await tree({ 'a.md': '# A\n', '.astpack/transcripts/x.json': '{}' });
    expect((await pack(root)).files.map((f) => f.path)).toEqual(['a.md']);
  });
});

describe('astpack doc', () => {
  it('prints documents as Markdown, by section and with page images on request', async () => {
    const root = await tree({
      'r.docx': docx(para('Report', 'Title') + para('Costs', 'Heading1') + para('Costs rose.') + para('Revenue', 'Heading1') + para('Revenue fell.')),
      'n.pdf': notes,
    });
    let out = '';
    let err = '';
    const io = { stdout: { write: (s: string) => ((out += s), true) }, stderr: { write: (s: string) => ((err += s), true) }, cwd: root } as never;
    expect(await run(['doc', 'r.docx', '--section', 'revenue', '--no-cache'], io)).toBe(0);
    expect(out).toBe('[document: r.docx · DOCX · 16 tokens as text]\n\n## Revenue\n\nRevenue fell.\n');
    out = '';
    expect(await run(['doc', 'n.pdf', '--pages', '2', '--images', 'img', '--no-cache'], io)).toBe(0);
    expect(out).toContain('[page 2: handwriting or drawing, no text layer]');
    expect(err).toMatch(/page 2 → .*img[/\\]n-p2\.png/);
    expect((await readFile(join(root, 'img', 'n-p2.png'))).subarray(1, 4).toString()).toBe('PNG');
    expect(await run(['doc', 'missing.pdf', '--no-cache'], io)).toBe(1);
  });
});
