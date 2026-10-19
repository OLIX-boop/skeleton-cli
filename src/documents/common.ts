import { unzipSync } from 'fflate';

/** A page of a paginated document that has no usable text layer (handwriting, a scan, a drawing). */
export interface VisualPage {
  /** 1-based page number. */
  page: number;
  /** What the page holds instead of text: vector strokes (handwriting, drawings) or images (scans, photos, figures). */
  kind: 'ink' | 'image';
  /** The page also has some real text (extracted as usual). */
  mixed: boolean;
}

export interface ConvertedDocument {
  /** The document as Markdown. Paginated formats mark pages with `<!-- page N -->`. */
  markdown: string;
  /** Format id (`pdf`, `docx`…). */
  format: string;
  /** Page (or slide / sheet) count, when the format has them. */
  pages?: number;
  /** Pages that need to be looked at as images. */
  visualPages?: VisualPage[];
  /** Blank pages, left out of `markdown`. */
  blankPages?: number[];
}

export class DocumentError extends Error {}

const decoder = new TextDecoder('utf-8');

export function utf8(bytes: Uint8Array): string {
  const text = decoder.decode(bytes);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Entries of a ZIP container (Office, OpenDocument, EPUB), optionally only those `keep` accepts. */
export function readZip(bytes: Uint8Array, keep?: (name: string) => boolean): Map<string, Uint8Array> {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, keep ? { filter: (file) => keep(file.name) } : undefined);
  } catch (error) {
    throw new DocumentError(`not a valid ZIP container (${(error as Error).message})`);
  }
  return new Map(Object.entries(files));
}

export function zipText(zip: Map<string, Uint8Array>, name: string): string | undefined {
  const bytes = zip.get(name);
  return bytes ? utf8(bytes) : undefined;
}

/** Collapse runs of whitespace (keeping explicit line breaks out of the way) and trim. */
export function squash(text: string): string {
  return text.replace(/[ \t\u00a0\f\v]+/g, ' ').replace(/ *\n */g, '\n').trim();
}

function cell(text: string): string {
  return squash(text).replace(/\n+/g, ' <br> ').replace(/\|/g, '\\|');
}

/** A Markdown table; the first row is the header. Empty trailing columns and rows are dropped. */
export function markdownTable(rows: string[][]): string {
  const cleaned = rows.map((r) => r.map(cell));
  while (cleaned.length && cleaned[cleaned.length - 1]!.every((c) => !c)) cleaned.pop();
  if (!cleaned.length) return '';
  let width = 0;
  for (const row of cleaned) {
    let last = row.length;
    while (last > 0 && !row[last - 1]) last--;
    width = Math.max(width, last);
  }
  if (width === 0) return '';
  const lines = cleaned.map((row) => {
    const cells = Array.from({ length: width }, (_, i) => row[i] ?? '');
    return `| ${cells.join(' | ')} |`;
  });
  lines.splice(1, 0, `|${' --- |'.repeat(width)}`);
  return lines.join('\n');
}

/** Join Markdown blocks with blank lines, dropping empty ones and collapsing excess blank lines. */
export function joinBlocks(blocks: readonly string[]): string {
  const text = blocks
    .map((b) => b.replace(/\s+$/, ''))
    .filter((b) => b.trim())
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n');
  return text ? `${text}\n` : '';
}

export function heading(level: number, text: string): string {
  const clean = squash(text).replace(/\n+/g, ' ');
  return clean ? `${'#'.repeat(Math.min(6, Math.max(1, level)))} ${clean}` : '';
}

/** Format a byte count for notes such as `[attachment: a.pdf, 12 KB]`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
