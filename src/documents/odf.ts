import { DocumentError, heading, joinBlocks, markdownTable, readZip, squash, zipText, type ConvertedDocument } from './common.js';
import { childElements, find, findAll, isElement, parseMarkup, type Element } from './markup.js';
import { sheetBlock } from './xlsx.js';

/**
 * OpenDocument files (LibreOffice and others): text (`.odt`), spreadsheets (`.ods`) and
 * presentations (`.odp`), all read from `content.xml`.
 */

/** Text of a paragraph-like element: spans, links, spaces, tabs and line breaks. */
function inline(element: Element): string {
  let out = '';
  for (const child of element.children) {
    if (!isElement(child)) {
      out += child;
      continue;
    }
    switch (child.name) {
      case 'text:s':
        out += ' '.repeat(Number(child.attrs['text:c'] ?? 1));
        break;
      case 'text:tab':
        out += ' ';
        break;
      case 'text:line-break':
        out += '\n';
        break;
      case 'text:note': {
        const body = find(child, 'text:note-body');
        out += body ? ` (${squash(childElements(body).map(inline).join(' '))})` : '';
        break;
      }
      case 'office:annotation':
      case 'text:tracked-changes':
        break;
      case 'draw:frame': {
        const description = find(child, 'svg:desc') ?? find(child, 'svg:title');
        out += description ? ` [image: ${squash(inline(description))}] ` : '';
        break;
      }
      default:
        out += inline(child);
    }
  }
  return out;
}

function list(element: Element, depth: number): string[] {
  const lines: string[] = [];
  for (const item of childElements(element)) {
    if (item.name !== 'text:list-item' && item.name !== 'text:list-header') continue;
    for (const child of childElements(item)) {
      if (child.name === 'text:list') lines.push(...list(child, depth + 1));
      else {
        const text = squash(inline(child)).replace(/\n+/g, ' ');
        if (text) lines.push(`${'  '.repeat(depth)}- ${text}`);
      }
    }
  }
  return lines;
}

function textTable(table: Element): string {
  const rows: string[][] = [];
  for (const row of findAll(table, 'table:table-row')) {
    rows.push(childElements(row, 'table:table-cell').map((cell) => childElements(cell).map(inline).join('\n')));
  }
  return markdownTable(rows);
}

function textBlocks(container: Element, out: string[]): void {
  for (const child of childElements(container)) {
    switch (child.name) {
      case 'text:h':
        out.push(heading(Number(child.attrs['text:outline-level'] ?? 1), inline(child)));
        break;
      case 'text:p':
        out.push(squash(inline(child)));
        break;
      case 'text:list':
        out.push(list(child, 0).join('\n'));
        break;
      case 'table:table':
        out.push(textTable(child));
        break;
      case 'text:section':
      case 'text:index-body':
      case 'text:table-of-content':
        textBlocks(child, out);
        break;
    }
  }
}

/** A cell's value: typed values (numbers, dates, booleans) from attributes, else its text. */
function cellValue(cell: Element): string {
  const type = cell.attrs['office:value-type'];
  if (type === 'date') return (cell.attrs['office:date-value'] ?? '').replace(/T00:00:00$/, '').replace('T', ' ');
  if (type === 'boolean') return (cell.attrs['office:boolean-value'] ?? '').toUpperCase();
  if (type === 'float' || type === 'percentage' || type === 'currency') return cell.attrs['office:value'] ?? squash(inline(cell));
  return childElements(cell, 'text:p').map((p) => squash(inline(p))).join('\n');
}

/** Repeated empty rows and columns pad sheets to a million cells: cap what is expanded. */
const MAX_REPEAT = 1000;

function sheetRows(table: Element): string[][] {
  const rows: string[][] = [];
  for (const row of findAll(table, 'table:table-row')) {
    const cells: string[] = [];
    for (const cell of childElements(row)) {
      if (cell.name !== 'table:table-cell' && cell.name !== 'table:covered-table-cell') continue;
      const value = cell.name === 'table:table-cell' ? cellValue(cell) : '';
      const repeat = Math.min(Number(cell.attrs['table:number-columns-repeated'] ?? 1), value ? MAX_REPEAT : 1);
      for (let i = 0; i < repeat; i++) cells.push(value);
    }
    const repeat = Math.min(Number(row.attrs['table:number-rows-repeated'] ?? 1), cells.some(Boolean) ? MAX_REPEAT : 1);
    for (let i = 0; i < repeat; i++) rows.push(cells);
  }
  return rows;
}

export function convertOdf(bytes: Uint8Array, format: 'odt' | 'ods' | 'odp'): ConvertedDocument {
  const zip = readZip(bytes, (name) => name === 'content.xml');
  const content = zipText(zip, 'content.xml');
  if (!content) throw new DocumentError('content.xml is missing');
  const body = find(parseMarkup(content), 'office:body');
  if (!body) return { markdown: '', format };
  if (format === 'ods') {
    const sheets = findAll(body, 'table:table');
    return {
      markdown: joinBlocks(sheets.map((t, i) => sheetBlock(t.attrs['table:name'] ?? `Sheet ${i + 1}`, sheetRows(t)))),
      format,
      pages: sheets.length,
    };
  }
  if (format === 'odp') {
    const pages = findAll(body, 'draw:page');
    const sections = pages.map((page, index) => {
      const out: string[] = [];
      for (const frame of findAll(page, 'draw:frame')) {
        if (frame.attrs['presentation:class'] === 'page-number' || frame.attrs['presentation:class'] === 'footer') continue;
        const box = find(frame, 'draw:text-box');
        if (box) textBlocks(box, out);
        const table = find(frame, 'table:table');
        if (table) out.push(textTable(table));
      }
      const notes = find(page, 'presentation:notes');
      const noteText: string[] = [];
      if (notes) for (const box of findAll(notes, 'draw:text-box')) textBlocks(box, noteText);
      const [title, ...rest] = out.filter(Boolean);
      return joinBlocks([`## Slide ${index + 1}${title ? `: ${title.replace(/^#+ /, '')}` : ''}`, ...rest, noteText.length ? `> Notes: ${noteText.join('\n> ')}` : '']);
    });
    return { markdown: joinBlocks(sections), format, pages: pages.length };
  }
  const text = find(body, 'office:text') ?? body;
  const out: string[] = [];
  textBlocks(text, out);
  return { markdown: joinBlocks(out), format };
}
