import type { WrappedPdfiumModule } from '@embedpdf/pdfium';
import { heading, joinBlocks, markdownTable, type ConvertedDocument, type VisualPage } from './common.js';
import { withPdf, withScratch } from './pdfium.js';

/**
 * PDFs, read with PDFium. Text pages are rebuilt into Markdown from glyph geometry:
 * headings from font size, paragraphs from line spacing, tables from the cell gaps PDFium
 * reports, repeated running headers, footers and page numbers dropped, and words hyphenated
 * across lines rejoined. Pages without a usable text layer (handwriting and drawings made of
 * vector strokes, as OneNote exports them; scans and photos) are listed as visual pages, to
 * be looked at as images (see `render.ts`).
 */

interface Line {
  page: number;
  text: string;
  /** Cell texts, when PDFium reported wide gaps between runs of the line. */
  cells: string[];
  x0: number;
  x1: number;
  /** Distance from the top of the page to the top of the line. */
  top: number;
  bottom: number;
  size: number;
  /** Set in a fixed-pitch font (code). */
  mono: boolean;
}

interface PageInfo {
  index: number;
  width: number;
  height: number;
  lines: Line[];
  /** Characters drawn invisibly (the OCR layer of a scanned page). */
  invisibleChars: number;
  /** Vector paths with curves (handwriting strokes, drawings, outlined text). */
  curvyPaths: number;
  /** Share of the page covered by images. */
  imageArea: number;
}

// PDFium constants.
const OBJ_TEXT = 1;
const OBJ_PATH = 2;
const OBJ_IMAGE = 3;
const OBJ_FORM = 5;
const SEGMENT_BEZIER = 1;
const TEXT_INVISIBLE = 3;

function objectStats(m: WrappedPdfiumModule, page: number, area: number) {
  const stats = { curvyPaths: 0, imageArea: 0, invisible: 0 };
  withScratch(m, 16, (box) => {
    const visit = (obj: number, depth: number) => {
      const type = m.FPDFPageObj_GetType(obj);
      if (type === OBJ_FORM && depth < 8) {
        const n = m.FPDFFormObj_CountObjects(obj);
        for (let i = 0; i < n; i++) visit(m.FPDFFormObj_GetObject(obj, i), depth + 1);
        return;
      }
      if (type === OBJ_TEXT) {
        if (m.FPDFTextObj_GetTextRenderMode(obj) === TEXT_INVISIBLE) stats.invisible++;
        return;
      }
      if (type !== OBJ_PATH && type !== OBJ_IMAGE) return;
      if (!m.FPDFPageObj_GetBounds(obj, box, box + 4, box + 8, box + 12)) return;
      const left = m.pdfium.getValue(box, 'float');
      const bottom = m.pdfium.getValue(box + 4, 'float');
      const right = m.pdfium.getValue(box + 8, 'float');
      const top = m.pdfium.getValue(box + 12, 'float');
      const w = Math.max(0, right - left);
      const h = Math.max(0, top - bottom);
      if (type === OBJ_IMAGE) {
        stats.imageArea += Math.min(area, w * h) / area;
        return;
      }
      if (Math.max(w, h) < 1.5) return;
      const segments = m.FPDFPath_CountSegments(obj);
      for (let s = 0; s < segments; s++) {
        if (m.FPDFPathSegment_GetType(m.FPDFPath_GetPathSegment(obj, s)) === SEGMENT_BEZIER) {
          stats.curvyPaths++;
          break;
        }
      }
    };
    const n = m.FPDFPage_CountObjects(page);
    for (let i = 0; i < n; i++) visit(m.FPDFPage_GetObject(page, i), 0);
  });
  stats.imageArea = Math.min(1, stats.imageArea);
  return stats;
}

const FIXED_PITCH = 1;

/** Whether the font of character `index` is fixed-pitch (sampled: font lookups are not free). */
function isFixedPitch(m: WrappedPdfiumModule, textPage: number, index: number, flags: number): boolean {
  m.FPDFText_GetFontInfo(textPage, index, 0, 0, flags);
  return (m.pdfium.getValue(flags, 'i32') & FIXED_PITCH) !== 0;
}

/** Characters PDFium uses for soft hyphens at line ends. */
// eslint-disable-next-line no-control-regex -- PDFium reports a soft hyphen as U+0002.
const SOFT_HYPHEN = /[\u0002\u00ad]$/;

function readLines(m: WrappedPdfiumModule, textPage: number, pageIndex: number, height: number): Line[] {
  const lines: Line[] = [];
  const count = m.FPDFText_CountChars(textPage);
  withScratch(m, 40, (box) => {
    const scratch = box + 32;
    let text = '';
    let cells: string[] = [];
    let cell = '';
    let x0 = Infinity;
    let x1 = -Infinity;
    let top = Infinity;
    let bottom = -Infinity;
    const sizes: number[] = [];
    let lastRight = NaN;
    let pendingGap = false;
    let realSpace = false;
    let mono = 0;
    let glyphs = 0;
    const flush = () => {
      if (text.trim()) {
        if (cell.trim()) cells.push(cell.trim());
        sizes.sort((a, b) => a - b);
        // Sampled glyphs (one in eight) nearly all fixed-pitch: inline code in prose doesn't count.
        const isMono = mono >= Math.ceil(glyphs / 8) * 8 * 0.9;
        // Code keeps its indentation and spacing.
        const clean = isMono ? text.replace(/\s+$/, '') : text.replace(/\s+/g, ' ').trim();
        lines.push({ page: pageIndex, text: clean, cells: cells.length > 1 ? cells : [], x0, x1, top, bottom, size: sizes[sizes.length >> 1] ?? 0, mono: isMono });
      }
      text = '';
      cells = [];
      cell = '';
      x0 = top = Infinity;
      x1 = bottom = -Infinity;
      sizes.length = 0;
      lastRight = NaN;
      pendingGap = false;
      realSpace = false;
      mono = glyphs = 0;
    };
    for (let i = 0; i < count; i++) {
      const code = m.FPDFText_GetUnicode(textPage, i);
      if (code === 13) continue;
      if (code === 10) {
        flush();
        continue;
      }
      // A word hyphenated across lines: PDFium reports the hyphen as U+0002 and no line break.
      if (code === 2) {
        text += '\u00ad';
        flush();
        continue;
      }
      const ch = String.fromCodePoint(code);
      const generated = m.FPDFText_IsGenerated(textPage, i) === 1;
      if (/\s/.test(ch)) {
        text += ' ';
        // A generated space is a gap PDFium inferred: maybe between words, maybe between cells.
        // Spaces actually in the text (aligned code, padded columns) never separate cells.
        if (generated) pendingGap = true;
        else realSpace = true;
        cell += ' ';
        continue;
      }
      if (!m.FPDFText_GetCharBox(textPage, i, box, box + 8, box + 16, box + 24)) continue;
      const left = m.pdfium.getValue(box, 'double');
      const right = m.pdfium.getValue(box + 8, 'double');
      const b = height - m.pdfium.getValue(box + 16, 'double');
      const t = height - m.pdfium.getValue(box + 24, 'double');
      const size = m.FPDFText_GetFontSize(textPage, i);
      const gap = left - lastRight;
      if (!Number.isNaN(lastRight) && !realSpace && gap > size * (pendingGap ? 0.4 : 1.2)) {
        if (cell.trim()) cells.push(cell.trim());
        cell = '';
      }
      pendingGap = realSpace = false;
      if (glyphs++ % 8 === 0 && isFixedPitch(m, textPage, i, scratch)) mono += 8;
      text += ch;
      cell += ch;
      x0 = Math.min(x0, left);
      x1 = Math.max(x1, right);
      top = Math.min(top, t);
      bottom = Math.max(bottom, b);
      sizes.push(size);
      lastRight = right;
    }
    flush();
  });
  return lines;
}

/** Normalize a line for comparing running headers and footers across pages. */
function signature(text: string): string {
  return text.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
}

const PAGE_NUMBER = /^(page|pagina|seite|página|p\.)?\s*#+(\s*(of|di|von|de|\/)\s*#+)?$|^[-–—]\s*#+\s*[-–—]$/;

function dropRunningLines(pages: PageInfo[]): void {
  const inBand = (line: Line, page: PageInfo) => line.top < page.height * 0.09 || line.bottom > page.height * 0.91;
  const counts = new Map<string, number>();
  for (const page of pages) {
    const seen = new Set<string>();
    for (const line of page.lines) if (inBand(line, page)) seen.add(signature(line.text));
    for (const s of seen) counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  const repeated = Math.max(2, Math.ceil(pages.length * 0.5));
  for (const page of pages) {
    page.lines = page.lines.filter((line) => {
      if (!inBand(line, page)) return true;
      const s = signature(line.text);
      return !(PAGE_NUMBER.test(s) || (pages.length > 1 && (counts.get(s) ?? 0) >= repeated));
    });
  }
}

/** The most common font size, weighted by text length. */
function bodySize(pages: PageInfo[]): number {
  const weight = new Map<number, number>();
  for (const page of pages) for (const line of page.lines) {
    const key = Math.round(line.size * 2) / 2;
    weight.set(key, (weight.get(key) ?? 0) + line.text.length);
  }
  let best = 0;
  let bestWeight = -1;
  for (const [size, w] of weight) if (w > bestWeight) [best, bestWeight] = [size, w];
  return best;
}

const BULLET = /^([•◦▪‣·●○■□➢►✓✔\-–*])\s+/;
const NUMBERED = /^(\(?\d{1,3}[.)]|\(?[a-z][.)])\s+/i;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1] ?? 0;
}

/** Rebuild the Markdown blocks of one page. */
function pageBlocks(page: PageInfo, body: number, headingLevels: number[]): string[] {
  const lines = page.lines;
  const out: string[] = [];
  if (!lines.length) return out;
  const pitches: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const d = lines[i]!.top - lines[i - 1]!.top;
    if (d > 0 && d < lines[i]!.size * 3) pitches.push(d);
  }
  const pitch = median(pitches) || body * 1.2;
  const left = median(lines.map((l) => l.x0));
  const right = Math.max(...lines.map((l) => l.x1));
  const width = Math.max(1, right - left);

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const level = headingLevels.findIndex((s) => Math.abs(s - line.size) < 0.6);
    // Tables: two or more consecutive lines split into a similar number of cells.
    if (line.cells.length >= 2) {
      let j = i + 1;
      while (j < lines.length && lines[j]!.cells.length >= 2 && Math.abs(lines[j]!.cells.length - line.cells.length) <= 1) j++;
      if (j - i >= 2) {
        out.push(markdownTable(lines.slice(i, j).map((l) => l.cells)));
        i = j;
        continue;
      }
    }
    // Consecutive fixed-pitch lines: a code block, line breaks and indentation kept.
    if (line.mono) {
      let j = i + 1;
      while (j < lines.length && lines[j]!.mono && lines[j]!.cells.length < 2 && lines[j]!.top - lines[j - 1]!.top < line.size * 2.5) j++;
      const indent = Math.min(...lines.slice(i, j).map((l) => l.x0));
      const charWidth = line.size * 0.6;
      const code = lines.slice(i, j).map((l) => ' '.repeat(Math.max(0, Math.round((l.x0 - indent) / charWidth))) + l.text.replace(/^\s+/, ''));
      out.push(`\`\`\`\n${code.join('\n')}\n\`\`\``);
      i = j;
      continue;
    }
    if (level !== -1 && line.text.length < 200) {
      let text = line.text;
      let j = i + 1;
      while (j < lines.length && Math.abs(lines[j]!.size - line.size) < 0.6 && lines[j]!.top - lines[j - 1]!.top < line.size * 1.6) {
        text += ` ${lines[j]!.text}`;
        j++;
      }
      out.push(heading(level + 1, text));
      i = j;
      continue;
    }
    // A paragraph (or list item): following lines join it while they look like its continuation.
    const bullet = BULLET.exec(line.text) ?? NUMBERED.exec(line.text);
    let text = bullet && BULLET.test(line.text) ? `- ${line.text.replace(BULLET, '')}` : line.text;
    let j = i + 1;
    while (j < lines.length) {
      const prev = lines[j - 1]!;
      const next = lines[j]!;
      const gap = next.top - prev.top;
      const sameSize = Math.abs(next.size - prev.size) < 0.6;
      const ragged = prev.x1 < left + width * 0.8;
      const startsItem = BULLET.test(next.text) || (NUMBERED.test(next.text) && !!bullet);
      const isHeading = headingLevels.some((s) => Math.abs(s - next.size) < 0.6);
      if (!sameSize || gap <= 0 || gap > pitch * 1.35 || ragged || startsItem || isHeading || next.cells.length >= 2 || next.mono) break;
      text = SOFT_HYPHEN.test(text) ? text.replace(SOFT_HYPHEN, '') + next.text : /\w-$/.test(text) && /^[a-zà-ÿ]/.test(next.text) ? text.slice(0, -1) + next.text : `${text} ${next.text}`;
      j++;
    }
    out.push(text.replace(SOFT_HYPHEN, ''));
    i = j;
  }
  // Consecutive list items form one block.
  const merged: string[] = [];
  for (const block of out) {
    const last = merged[merged.length - 1];
    if (last !== undefined && /^(- |\d{1,3}[.)] )/.test(block) && /(^|\n)(- |\d{1,3}[.)] )[^\n]*$/.test(last)) merged[merged.length - 1] = `${last}\n${block}`;
    else merged.push(block);
  }
  return merged;
}

function classify(page: PageInfo): { blank: boolean; visual?: VisualPage } {
  // Count what remains once running headers and footers are gone: a page of handwriting
  // under a printed "Page 3 of 9" has no text of its own.
  const chars = page.lines.reduce((n, line) => n + line.text.replace(/\s/g, '').length, 0);
  const fewText = chars < 15;
  const scanned = page.imageArea >= 0.5;
  if (fewText && page.curvyPaths < 3 && page.imageArea < 0.02) return { blank: chars === 0 };
  if (fewText || (scanned && page.invisibleChars > 0)) {
    const kind = page.imageArea >= 0.2 ? 'image' : 'ink';
    return { blank: false, visual: { page: page.index + 1, kind, mixed: !fewText } };
  }
  if (page.curvyPaths >= 25 || page.imageArea >= 0.25) {
    return { blank: false, visual: { page: page.index + 1, kind: page.imageArea >= 0.25 ? 'image' : 'ink', mixed: true } };
  }
  return { blank: false };
}

export function visualNote(visual: VisualPage): string {
  if (!visual.mixed) {
    return visual.kind === 'ink'
      ? `[page ${visual.page}: handwriting or drawing, no text layer]`
      : `[page ${visual.page}: scanned page or image, no text layer]`;
  }
  return visual.kind === 'ink'
    ? `[page ${visual.page}: also has handwriting or drawings, not in the text above]`
    : `[page ${visual.page}: also has an image or figure, or is a scan with an OCR text layer]`;
}

/** Read every page's text lines and object statistics. */
async function analyse(bytes: Uint8Array): Promise<PageInfo[]> {
  return withPdf(bytes, (m, doc) => {
    const pages: PageInfo[] = [];
    const count = m.FPDF_GetPageCount(doc);
    for (let index = 0; index < count; index++) {
      const page = m.FPDF_LoadPage(doc, index);
      if (!page) continue;
      try {
        const width = m.FPDF_GetPageWidthF(page);
        const height = m.FPDF_GetPageHeightF(page);
        const textPage = m.FPDFText_LoadPage(page);
        const lines = textPage ? readLines(m, textPage, index, height) : [];
        if (textPage) m.FPDFText_ClosePage(textPage);
        const stats = objectStats(m, page, Math.max(1, width * height));
        pages.push({ index, width, height, lines, invisibleChars: stats.invisible, curvyPaths: stats.curvyPaths, imageArea: stats.imageArea });
      } finally {
        m.FPDF_ClosePage(page);
      }
    }
    return pages;
  });
}

export async function convertPdf(bytes: Uint8Array): Promise<ConvertedDocument> {
  const pages = await analyse(bytes);
  dropRunningLines(pages);
  const body = bodySize(pages);
  // Font sizes clearly larger than the body text, largest first, become heading levels.
  const sizes = new Map<number, number>();
  for (const page of pages) for (const line of page.lines) {
    if (line.size >= body * 1.15 && line.text.length < 200) {
      const key = Math.round(line.size * 2) / 2;
      sizes.set(key, (sizes.get(key) ?? 0) + 1);
    }
  }
  const headingLevels = [...sizes.keys()].sort((a, b) => b - a).slice(0, 4);
  const visualPages: VisualPage[] = [];
  const blankPages: number[] = [];
  const sections: string[] = [];
  for (const page of pages) {
    const { blank, visual } = classify(page);
    if (blank) {
      blankPages.push(page.index + 1);
      continue;
    }
    const blocks = visual && !visual.mixed ? [] : pageBlocks(page, body, headingLevels);
    if (visual) {
      visualPages.push(visual);
      blocks.push(visualNote(visual));
    }
    sections.push(joinBlocks([`<!-- page ${page.index + 1} -->`, ...blocks]));
  }
  return {
    markdown: joinBlocks(sections),
    format: 'pdf',
    pages: pages.length,
    ...(visualPages.length ? { visualPages } : {}),
    ...(blankPages.length ? { blankPages } : {}),
  };
}
