/**
 * Condensing converted documents, the counterpart of skeletons for prose: the structure
 * (headings, pages, tables, notes about pages to look at) stays, the bulk of the text is cut
 * to a short lead per section. Also selects sections or pages for targeted reads.
 */

export type BlockKind = 'heading' | 'page' | 'note' | 'table' | 'fence' | 'list' | 'quote' | 'paragraph';

export interface Block {
  kind: BlockKind;
  text: string;
  /** Heading level (1-6). */
  level?: number;
  /** Page number, for page markers. */
  page?: number;
}

const PAGE_MARKER = /^<!-- page (\d+)(?: \([^)]*\))? -->$/;
const NOTE = /^\[(page \d+|slide \d+|image|attachment)[:\],]/;

/** Split Markdown into blocks, keeping fenced code blocks whole. */
export function parseBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  const lines = markdown.split('\n');
  let buffer: string[] = [];
  const flush = () => {
    if (!buffer.length) return;
    const text = buffer.join('\n');
    buffer = [];
    const first = text.trimStart();
    const h = /^(#{1,6}) (.*)$/.exec(text);
    const page = PAGE_MARKER.exec(first);
    if (h && !text.includes('\n')) blocks.push({ kind: 'heading', text, level: h[1]!.length });
    else if (page) blocks.push({ kind: 'page', text, page: Number(page[1]) });
    else if (NOTE.test(first)) blocks.push({ kind: 'note', text });
    else if (first.startsWith('|')) blocks.push({ kind: 'table', text });
    else if (/^(\s*)([-*+]|\d{1,3}[.)]) /.test(first)) blocks.push({ kind: 'list', text });
    else if (first.startsWith('>')) blocks.push({ kind: 'quote', text });
    else blocks.push({ kind: 'paragraph', text });
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^```/.test(line)) {
      flush();
      const fence = [line];
      while (++i < lines.length) {
        fence.push(lines[i]!);
        if (/^```\s*$/.test(lines[i]!)) break;
      }
      blocks.push({ kind: 'fence', text: fence.join('\n') });
      continue;
    }
    if (!line.trim()) flush();
    else if (/^#{1,6} /.test(line) || PAGE_MARKER.test(line.trim())) {
      // Headings and page markers stand alone even without blank lines around them.
      flush();
      buffer.push(line);
      flush();
    } else buffer.push(line);
  }
  flush();
  return blocks;
}

function countWords(text: string): number {
  return text.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
}

/** The first sentences of a paragraph, up to about `max` characters. */
function lead(text: string, max = 280): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const sentences = flat.match(/[^.!?]+[.!?]+(\s|$)/g) ?? [];
  let out = '';
  for (const s of sentences) {
    if (out && out.length + s.length > max) break;
    out += s;
  }
  if (!out || out.length > max * 1.5) out = `${flat.slice(0, max).replace(/\s+\S*$/, '')}…`;
  return out.trim();
}

function condenseTable(text: string, keep = 3): string {
  const rows = text.split('\n');
  // Header, separator, then data rows.
  if (rows.length <= keep + 3) return text;
  return `${rows.slice(0, keep + 2).join('\n')}\n[… ${rows.length - keep - 2} more rows]`;
}

function condenseFence(text: string, keep = 10): string {
  const lines = text.split('\n');
  const body = lines.length - 2;
  if (body <= keep + 3) return text;
  return `${lines.slice(0, keep + 1).join('\n')}\n… [${body - keep} more lines]\n${lines[lines.length - 1]}`;
}

function condenseList(text: string, keep = 5): string {
  const items = text.split('\n');
  if (items.length <= keep + 2) return text;
  return `${items.slice(0, keep).join('\n')}\n[… ${items.length - keep} more items]`;
}

/** Below this size a document is cheap enough to keep whole in skeleton mode. */
export const SMALL_DOCUMENT_CHARS = 6000;

/**
 * Skeleton of a document: headings, page markers, notes and the lead of each section; long
 * tables, lists and code blocks shortened; the rest summarised as `[… N paragraphs, W words]`.
 */
export function condenseDocument(markdown: string): string {
  if (markdown.length <= SMALL_DOCUMENT_CHARS) return markdown;
  const out: string[] = [];
  let skipped = 0;
  let skippedWords = 0;
  let leadTaken = false;
  const flushSkipped = () => {
    if (skipped) out.push(`[… ${skipped} more paragraph${skipped === 1 ? '' : 's'}, ${skippedWords} words]`);
    skipped = skippedWords = 0;
  };
  for (const block of parseBlocks(markdown)) {
    switch (block.kind) {
      case 'heading':
        flushSkipped();
        out.push(block.text);
        leadTaken = false;
        break;
      case 'page':
      case 'note':
        flushSkipped();
        out.push(block.text);
        break;
      case 'table':
        flushSkipped();
        out.push(condenseTable(block.text));
        break;
      case 'fence':
        flushSkipped();
        out.push(condenseFence(block.text));
        break;
      case 'list':
        flushSkipped();
        out.push(condenseList(block.text));
        break;
      default:
        if (!leadTaken) {
          flushSkipped();
          out.push(lead(block.text));
          leadTaken = true;
        } else {
          skipped++;
          skippedWords += countWords(block.text);
        }
    }
  }
  flushSkipped();
  return `${dropEmptyPages(out).join('\n\n')}\n`;
}

/** Page markers immediately followed by another marker carry no information. */
function dropEmptyPages(blocks: string[]): string[] {
  return blocks.filter((b, i) => !(PAGE_MARKER.test(b) && (i === blocks.length - 1 || PAGE_MARKER.test(blocks[i + 1]!))));
}

/**
 * Outline of a document: every heading with the size of its section (and the page it starts
 * on), plus the notes about visual pages. Documents without headings list each page's (or
 * else each paragraph's) opening words.
 */
export function outlineDocument(markdown: string): string {
  const blocks = parseBlocks(markdown);
  const out: string[] = [];
  let page: number | undefined;
  const hasHeadings = blocks.some((b) => b.kind === 'heading');
  if (hasHeadings) {
    let current: { line: string; words: number } | undefined;
    const close = () => {
      if (current) out.push(`${current.line} (${current.words} words)`);
      current = undefined;
    };
    for (const block of blocks) {
      if (block.kind === 'page') page = block.page;
      else if (block.kind === 'heading') {
        close();
        current = { line: `${'  '.repeat(block.level! - 1)}${block.text.replace(/^#+ /, '')}${page ? ` [p.${page}]` : ''}`, words: 0 };
      } else if (block.kind === 'note') {
        close();
        out.push(block.text);
      } else if (current) current.words += countWords(block.text);
      else {
        // Text before the first heading.
        current = { line: '(preamble)', words: countWords(block.text) };
      }
    }
    close();
    return `${out.join('\n')}\n`;
  }
  const pages = blocks.filter((b) => b.kind === 'page');
  if (pages.length) {
    let pageWords = 0;
    let first = '';
    const close = () => {
      if (page !== undefined) out.push(`p.${page}: ${first ? `${lead(first, 90)} ` : ''}(${pageWords} words)`);
    };
    for (const block of blocks) {
      if (block.kind === 'page') {
        close();
        page = block.page;
        pageWords = 0;
        first = '';
      } else if (block.kind === 'note') out.push(block.text);
      else {
        pageWords += countWords(block.text);
        if (!first && block.kind === 'paragraph') first = block.text;
      }
    }
    close();
    return `${out.join('\n')}\n`;
  }
  const paragraphs = blocks.filter((b) => b.kind !== 'note');
  const step = Math.max(1, Math.ceil(paragraphs.length / 40));
  for (let i = 0; i < paragraphs.length; i += step) out.push(`- ${lead(paragraphs[i]!.text, 90)}`);
  for (const note of blocks.filter((b) => b.kind === 'note')) out.push(note.text);
  return `${out.join('\n')}\n`;
}

/** The sections whose heading contains `query` (case-insensitive), each up to the next heading of the same or a higher level. */
export function selectSections(markdown: string, query: string): string | undefined {
  const blocks = parseBlocks(markdown);
  const needle = query.toLowerCase().trim();
  const out: string[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    if (block.kind !== 'heading' || !block.text.toLowerCase().includes(needle)) continue;
    const section = [block.text];
    let j = i + 1;
    for (; j < blocks.length; j++) {
      const next = blocks[j]!;
      if (next.kind === 'heading' && next.level! <= block.level!) break;
      section.push(next.text);
    }
    out.push(section.join('\n\n'));
    i = j - 1;
  }
  return out.length ? `${out.join('\n\n')}\n` : undefined;
}

/** Parse a page list such as `3`, `2-5` or `1,4,7-9`. */
export function parsePages(spec: string | readonly number[]): number[] {
  if (Array.isArray(spec)) return [...new Set(spec as number[])].sort((a, b) => a - b);
  const pages = new Set<number>();
  for (const part of (spec as string).split(',')) {
    const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(part);
    if (!m) throw new Error(`invalid page list: ${spec}`);
    const from = Number(m[1]);
    const to = Number(m[2] ?? m[1]);
    if (to < from || to - from > 10_000) throw new Error(`invalid page range: ${part.trim()}`);
    for (let p = from; p <= to; p++) pages.add(p);
  }
  return [...pages].sort((a, b) => a - b);
}

/** The given pages of a paginated document (marked with `<!-- page N -->`). */
export function selectPages(markdown: string, pages: readonly number[]): string {
  const wanted = new Set(pages);
  const out: string[] = [];
  let keep = false;
  for (const block of parseBlocks(markdown)) {
    if (block.kind === 'page') keep = wanted.has(block.page!);
    if (keep) out.push(block.text);
  }
  return out.length ? `${out.join('\n\n')}\n` : '';
}

/** Number of the last page marker, or 0 for documents without pages. */
export function pageCount(markdown: string): number {
  let last = 0;
  for (const m of markdown.matchAll(/^<!-- page (\d+)/gm)) last = Math.max(last, Number(m[1]));
  return last;
}
