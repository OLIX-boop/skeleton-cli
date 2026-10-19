import { posix } from 'node:path';
import { DocumentError, joinBlocks, readZip, zipText, type ConvertedDocument } from './common.js';
import { childElements, findAll, firstChild, isElement, parseMarkup, textOf, type Element } from './markup.js';

/**
 * Excel workbooks (`.xlsx`, `.xlsm`): each sheet as CSV (cached formula results, dates as
 * ISO dates), trailing empty rows and columns dropped. CSV is the most token-efficient
 * tabular text; condensing (header plus sample rows) happens later, by mode.
 */

/** Quote a CSV field when needed. */
export function csvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Rows as CSV, without trailing empty rows and columns. */
export function toCsv(rows: string[][]): string {
  let height = rows.length;
  while (height > 0 && rows[height - 1]!.every((c) => !c)) height--;
  let width = 0;
  for (let r = 0; r < height; r++) {
    const row = rows[r]!;
    let last = row.length;
    while (last > 0 && !row[last - 1]) last--;
    width = Math.max(width, last);
  }
  const lines: string[] = [];
  for (let r = 0; r < height; r++) {
    const row = rows[r]!;
    lines.push(Array.from({ length: width }, (_, c) => csvField(row[c] ?? '')).join(','));
  }
  return lines.join('\n');
}

export function sheetBlock(name: string, rows: string[][]): string {
  const csv = toCsv(rows);
  if (!csv) return `## Sheet: ${name}\n\n(empty)`;
  const lines = csv.split('\n').length;
  return `## Sheet: ${name} (${lines} row${lines === 1 ? '' : 's'})\n\n\`\`\`csv\n${csv}\n\`\`\``;
}

/** Column letters → 0-based index (`A` → 0, `AA` → 26). */
function columnIndex(ref: string): number {
  let n = 0;
  for (const c of ref) {
    const code = c.charCodeAt(0);
    if (code < 65 || code > 90) break;
    n = n * 26 + (code - 64);
  }
  return n - 1;
}

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);

function dateStyles(xml: string | undefined): Set<number> {
  const out = new Set<number>();
  if (!xml) return out;
  const root = parseMarkup(xml);
  const custom = new Map<number, string>();
  for (const f of findAll(root, 'numFmt')) custom.set(Number(f.attrs.numFmtId), f.attrs.formatCode ?? '');
  const cellXfs = findAll(root, 'cellXfs')[0];
  if (!cellXfs) return out;
  childElements(cellXfs, 'xf').forEach((xf, index) => {
    const id = Number(xf.attrs.numFmtId ?? 0);
    // A custom format is a date if it has date parts outside quoted literals and [colour] tags.
    const code = (custom.get(id) ?? '').replace(/"[^"]*"|\[[^\]]*\]|\\./g, '');
    if (BUILTIN_DATE_FORMATS.has(id) || (custom.has(id) && /[dmy]/i.test(code) && !/^[#0.,%\s]*$/.test(code))) out.add(index);
  });
  return out;
}

/** An Excel serial date (1900 system) as ISO, with the time when it has one. */
export function serialToIso(serial: number): string {
  const ms = Math.round((serial - 25569) * 86_400_000);
  const iso = new Date(ms).toISOString();
  return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.slice(0, 19).replace('T', ' ');
}

function sharedStrings(xml: string | undefined): string[] {
  if (!xml) return [];
  return findAll(parseMarkup(xml), 'si').map((si) => {
    let text = '';
    for (const child of si.children) {
      if (!isElement(child)) continue;
      // Phonetic runs (rPh) are reading aids, not content.
      if (child.name === 't') text += textOf(child);
      else if (child.name === 'r') text += textOf(firstChild(child, 't') ?? child);
    }
    return text;
  });
}

function cellValue(c: Element, strings: string[], dates: Set<number>): string {
  const type = c.attrs.t;
  const v = firstChild(c, 'v');
  const raw = v ? textOf(v) : '';
  // A formula never calculated (written by a script, not Excel): show the formula.
  const formula = firstChild(c, 'f');
  if (!raw && formula && textOf(formula)) return `=${textOf(formula)}`;
  switch (type) {
    case 's':
      return strings[Number(raw)] ?? '';
    case 'inlineStr':
      return textOf(firstChild(c, 'is') ?? c);
    case 'b':
      return raw === '1' ? 'TRUE' : raw === '0' ? 'FALSE' : raw;
    case 'str':
    case 'e':
      return raw;
    default: {
      if (raw && dates.has(Number(c.attrs.s ?? -1))) {
        const n = Number(raw);
        if (Number.isFinite(n)) return serialToIso(n);
      }
      return raw;
    }
  }
}

export function convertXlsx(bytes: Uint8Array): ConvertedDocument {
  const zip = readZip(bytes, (name) => name.startsWith('xl/') && (name.endsWith('.xml') || name.endsWith('.rels')));
  const workbook = zipText(zip, 'xl/workbook.xml');
  if (!workbook) throw new DocumentError('xl/workbook.xml is missing');
  const rels = new Map<string, string>();
  for (const rel of findAll(parseMarkup(zipText(zip, 'xl/_rels/workbook.xml.rels') ?? ''), 'Relationship')) {
    const target = rel.attrs.Target ?? '';
    rels.set(rel.attrs.Id ?? '', target.startsWith('/') ? target.slice(1) : posix.normalize(posix.join('xl', target)));
  }
  const strings = sharedStrings(zipText(zip, 'xl/sharedStrings.xml'));
  const dates = dateStyles(zipText(zip, 'xl/styles.xml'));
  const sheets = findAll(parseMarkup(workbook), 'sheet');
  const blocks: string[] = [];
  for (const sheet of sheets) {
    if (sheet.attrs.state === 'hidden' || sheet.attrs.state === 'veryHidden') continue;
    const xml = zipText(zip, rels.get(sheet.attrs['r:id'] ?? '') ?? '');
    if (!xml) continue;
    const rows: string[][] = [];
    for (const row of findAll(parseMarkup(xml), 'row')) {
      const r = Number(row.attrs.r ?? rows.length + 1) - 1;
      const cells: string[] = [];
      let next = 0;
      for (const c of childElements(row, 'c')) {
        const col = c.attrs.r ? columnIndex(c.attrs.r) : next;
        cells[col] = cellValue(c, strings, dates);
        next = col + 1;
      }
      // Cap pathological sheets (a stray cell at row 1,000,000).
      if (r > rows.length + 10_000) break;
      rows[r] = Array.from(cells, (v) => v ?? '');
    }
    blocks.push(sheetBlock(sheet.attrs.name ?? `Sheet ${blocks.length + 1}`, Array.from(rows, (r) => r ?? [])));
  }
  return { markdown: joinBlocks(blocks), format: 'xlsx', pages: blocks.length };
}
