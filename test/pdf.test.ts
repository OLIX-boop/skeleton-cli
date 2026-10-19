import { describe, expect, it } from 'vitest';
import { convertPdf } from '../src/documents/pdf.js';
import { contentBox, renderPdfPages } from '../src/documents/render.js';
import { ink, pdf, text } from './documents-fixtures.js';

const header = (n: number, total: number) => text(250, 815, 8, 'ACME Corp - Confidential') + text(270, 20, 8, `Page ${n} of ${total}`);

/** Body text: lines that fill the column, the last one short (a paragraph end). */
function paragraph(y: number, lines: string[]): string {
  return lines.map((line, i) => text(72, y - i * 14, 11, line)).join('');
}

const LINE = 'The quarterly results show that revenue increased by twelve percent compared to the';
const report = pdf([
  {
    content:
      header(1, 5) +
      text(72, 760, 24, 'Annual Report') +
      text(72, 720, 16, 'Summary') +
      paragraph(690, [LINE, 'previous period, driven mainly by subscription renewals and lower churn in the infor-', 'mation services segment.']) +
      paragraph(630, [LINE, 'second half of the year.']) +
      text(72, 580, 16, 'Revenue by region') +
      ['Region', 'Q1', 'Q2'].map((c, i) => text(72 + i * 120, 550, 11, c)).join('') +
      ['Europe', '1,200', '1,350'].map((c, i) => text(72 + i * 120, 534, 11, c)).join('') +
      ['Americas', '980', '1,105'].map((c, i) => text(72 + i * 120, 518, 11, c)).join(''),
  },
  { content: header(2, 5) + text(72, 760, 16, 'Notes from the meeting') + paragraph(730, [LINE, 'end of the meeting.']) + ink(30, 80, 600) },
  { content: header(3, 5) + ink(36, 80, 700) },
  { content: header(4, 5) + 'q 500 0 0 700 48 70 cm /Im1 Do Q\n', image: true },
  { content: '' },
]);

describe('PDF conversion', () => {
  it('rebuilds headings, paragraphs and tables, without running headers, footers or page numbers', async () => {
    const result = await convertPdf(report);
    expect(result.pages).toBe(5);
    const page1 = result.markdown.slice(0, result.markdown.indexOf('<!-- page 2 -->'));
    expect(page1).toBe(
      [
        '<!-- page 1 -->',
        '# Annual Report',
        '## Summary',
        `${LINE} previous period, driven mainly by subscription renewals and lower churn in the information services segment.`,
        `${LINE} second half of the year.`,
        '## Revenue by region',
        '| Region | Q1 | Q2 |\n| --- | --- | --- |\n| Europe | 1,200 | 1,350 |\n| Americas | 980 | 1,105 |',
        '',
      ].join('\n\n'),
    );
    expect(result.markdown).not.toMatch(/Confidential|Page \d of/);
  });

  it('finds pages to look at: handwriting with or without text, scans; skips blank pages', async () => {
    const result = await convertPdf(report);
    expect(result.visualPages).toEqual([
      { page: 2, kind: 'ink', mixed: true },
      { page: 3, kind: 'ink', mixed: false },
      { page: 4, kind: 'image', mixed: false },
    ]);
    expect(result.blankPages).toEqual([5]);
    expect(result.markdown).toContain('## Notes from the meeting');
    expect(result.markdown).toContain('[page 2: also has handwriting or drawings, not in the text above]');
    expect(result.markdown).toContain('<!-- page 3 -->\n\n[page 3: handwriting or drawing, no text layer]');
    expect(result.markdown).toContain('[page 4: scanned page or image, no text layer]');
    expect(result.markdown).not.toContain('<!-- page 5 -->');
  });

  it('reports unreadable files', async () => {
    await expect(convertPdf(Buffer.from('not a pdf'))).rejects.toThrow(/not a PDF or corrupted/);
  });
});

describe('page rendering', () => {
  it('renders grayscale PNGs cropped to the ink, far smaller than the page', async () => {
    const [page] = await renderPdfPages(report, [3]);
    expect(Buffer.from(page!.png.subarray(1, 4)).toString()).toBe('PNG');
    // 36 strokes in 6 rows of 6, from (80, 700): a block in the upper part of the page.
    expect(page!.kept).toBeLessThan(0.35);
    expect(page!.tokens).toBeLessThan(800);
    expect(page!.width).toBeGreaterThan(page!.height);
  });

  it('leaves out blank pages and rejects missing ones', async () => {
    expect(await renderPdfPages(report, [5])).toEqual([]);
    await expect(renderPdfPages(report, [9])).rejects.toThrow(/page 9 does not exist/);
  });

  it('ignores small isolated marks when cropping', () => {
    const width = 100;
    const height = 200;
    const gray = new Uint8Array(width * height).fill(255);
    for (let y = 20; y < 80; y++) for (let x = 10; x < 90; x++) gray[y * width + x] = 0;
    // A page number far below.
    for (let y = 190; y < 193; y++) for (let x = 48; x < 52; x++) gray[y * width + x] = 0;
    const box = contentBox(gray, width, height)!;
    expect(box.y1).toBeLessThan(90);
    expect(box.x0).toBeLessThan(10);
  });
});
