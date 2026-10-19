import { DocumentError, heading, joinBlocks, markdownTable, readZip, squash, zipText, type ConvertedDocument } from './common.js';
import { childElements, find, findAll, firstChild, isElement, parseMarkup, type Element } from './markup.js';

/**
 * Word documents (`.docx`, Office Open XML): headings from paragraph styles and outline
 * levels, lists from numbering, tables, footnotes and image descriptions. Formatting, page
 * headers and footers, comments and tracked deletions are dropped.
 */

interface Styles {
  /** styleId → heading level (a title counts as level 0). */
  headings: Map<string, number>;
  /** styleId → the numbering a list style applies (`List Bullet`, `List Number`…). */
  lists: Map<string, { numId: string; ilvl: string }>;
}

interface Numbering {
  /** numId → ilvl → ordered? */
  ordered: Map<string, Map<string, boolean>>;
}

interface Context {
  styles: Styles;
  numbering: Numbering;
  footnotes: Map<string, string>;
  /** Footnote ids referenced, in order. */
  used: string[];
  /** Added to heading levels: 1 when the document has a title, so its headings sit below it. */
  shift: number;
}

function attr(element: Element | undefined, name: string): string | undefined {
  return element?.attrs[name] ?? element?.attrs[`w:${name}`];
}

function readStyles(xml: string | undefined): Styles {
  const headings = new Map<string, number>();
  const lists = new Map<string, { numId: string; ilvl: string }>();
  if (!xml) return { headings, lists };
  for (const style of findAll(parseMarkup(xml), 'w:style')) {
    const id = attr(style, 'styleId');
    if (!id) continue;
    const name = (attr(firstChild(style, 'w:name'), 'val') ?? '').toLowerCase();
    const outline = attr(find(style, 'w:outlineLvl'), 'val');
    const match = /^heading\s*(\d)$/.exec(name);
    if (name === 'title') headings.set(id, 0);
    else if (match) headings.set(id, Number(match[1]));
    else if (outline !== undefined && Number(outline) < 9) headings.set(id, Number(outline) + 1);
    const numPr = find(style, 'w:numPr');
    const numId = attr(firstChild(numPr ?? style, 'w:numId'), 'val');
    if (numPr && numId && numId !== '0') lists.set(id, { numId, ilvl: attr(firstChild(numPr, 'w:ilvl'), 'val') ?? '0' });
  }
  return { headings, lists };
}

function readNumbering(xml: string | undefined): Numbering {
  const ordered = new Map<string, Map<string, boolean>>();
  if (!xml) return { ordered };
  const root = parseMarkup(xml);
  const abstract = new Map<string, Map<string, boolean>>();
  for (const a of findAll(root, 'w:abstractNum')) {
    const levels = new Map<string, boolean>();
    for (const lvl of childElements(a, 'w:lvl')) {
      const format = attr(firstChild(lvl, 'w:numFmt'), 'val') ?? 'bullet';
      levels.set(attr(lvl, 'ilvl') ?? '0', format !== 'bullet' && format !== 'none');
    }
    abstract.set(attr(a, 'abstractNumId') ?? '', levels);
  }
  for (const num of findAll(root, 'w:num')) {
    const levels = abstract.get(attr(firstChild(num, 'w:abstractNumId'), 'val') ?? '');
    if (levels) ordered.set(attr(num, 'numId') ?? '', levels);
  }
  return { ordered };
}

/** Text of a paragraph's runs: text, tabs, breaks, footnote marks and image descriptions. */
function runText(element: Element, ctx: Context): string {
  let out = '';
  for (const child of element.children) {
    if (!isElement(child)) continue;
    switch (child.name) {
      case 'w:t':
        out += child.children.filter((c) => typeof c === 'string').join('');
        break;
      case 'w:tab':
        out += '\t';
        break;
      case 'w:br':
      case 'w:cr':
        out += '\n';
        break;
      case 'w:noBreakHyphen':
        out += '-';
        break;
      case 'w:footnoteReference':
      case 'w:endnoteReference': {
        const id = `${child.name === 'w:endnoteReference' ? 'e' : ''}${attr(child, 'id') ?? ''}`;
        if (ctx.footnotes.has(id)) {
          if (!ctx.used.includes(id)) ctx.used.push(id);
          out += `[^${ctx.used.indexOf(id) + 1}]`;
        }
        break;
      }
      case 'w:drawing':
      case 'w:pict': {
        const doc = find(child, 'wp:docPr');
        const description = doc?.attrs.descr || doc?.attrs.title;
        out += description ? ` [image: ${squash(description)}] ` : ' [image] ';
        // Text boxes hold paragraphs of their own.
        const box = find(child, 'w:txbxContent');
        if (box) out += ` ${childElements(box, 'w:p').map((p) => runText(p, ctx)).join(' ')} `;
        break;
      }
      case 'w:del':
      case 'w:instrText':
      case 'w:delText':
      case 'w:rPr':
      case 'w:pPr':
        break;
      default:
        out += runText(child, ctx);
    }
  }
  return out;
}

function paragraph(p: Element, ctx: Context): string {
  const pPr = firstChild(p, 'w:pPr');
  const text = squash(runText(p, ctx).replace(/\t/g, ' '));
  if (!text) return '';
  const style = attr(firstChild(pPr ?? p, 'w:pStyle'), 'val');
  const outline = attr(firstChild(pPr ?? p, 'w:outlineLvl'), 'val');
  const level = style !== undefined ? ctx.styles.headings.get(style) : undefined;
  if (level !== undefined) return heading(level === 0 ? 1 : level + ctx.shift, text);
  if (outline !== undefined && Number(outline) < 9) return heading(Number(outline) + 1 + ctx.shift, text);
  const numPr = pPr && firstChild(pPr, 'w:numPr');
  const styleList = style !== undefined ? ctx.styles.lists.get(style) : undefined;
  if (numPr || styleList) {
    const ilvl = (numPr && attr(firstChild(numPr, 'w:ilvl'), 'val')) ?? styleList?.ilvl ?? '0';
    const numId = (numPr && attr(firstChild(numPr, 'w:numId'), 'val')) ?? styleList?.numId ?? '';
    if (numId !== '0') {
      const ordered = ctx.numbering.ordered.get(numId)?.get(ilvl) ?? false;
      return `${'  '.repeat(Number(ilvl) || 0)}${ordered ? '1.' : '-'} ${text.replace(/\n/g, ' ')}`;
    }
  }
  return text;
}

function table(tbl: Element, ctx: Context): string {
  const rows = childElements(tbl, 'w:tr').map((tr) =>
    childElements(tr, 'w:tc').map((tc) => blocks(tc, ctx).join('\n')),
  );
  return markdownTable(rows);
}

/** The blocks (paragraphs, tables) of a body-like element. */
function blocks(container: Element, ctx: Context): string[] {
  const out: string[] = [];
  let list: string[] = [];
  const flushList = () => {
    if (list.length) out.push(list.join('\n'));
    list = [];
  };
  for (const child of container.children) {
    if (!isElement(child)) continue;
    if (child.name === 'w:p') {
      const text = paragraph(child, ctx);
      if (/^\s*(-|1\.) /.test(text)) {
        list.push(text);
        continue;
      }
      flushList();
      out.push(text);
    } else if (child.name === 'w:tbl') {
      flushList();
      out.push(table(child, ctx));
    } else if (child.name === 'w:sdt') {
      flushList();
      const content = firstChild(child, 'w:sdtContent');
      if (content) out.push(...blocks(content, ctx));
    } else if (child.name === 'w:customXml' || child.name === 'w:ins' || child.name === 'w:smartTag') {
      flushList();
      out.push(...blocks(child, ctx));
    }
  }
  flushList();
  return out;
}

function readNotes(xml: string | undefined, element: string, prefix: string, ctx: Context): void {
  if (!xml) return;
  for (const note of findAll(parseMarkup(xml), element)) {
    const id = attr(note, 'id');
    const type = attr(note, 'type');
    if (!id || type === 'separator' || type === 'continuationSeparator') continue;
    ctx.footnotes.set(`${prefix}${id}`, squash(blocks(note, { ...ctx, used: [] }).join(' ')));
  }
}

export function convertDocx(bytes: Uint8Array): ConvertedDocument {
  const zip = readZip(bytes, (name) => name.startsWith('word/') && name.endsWith('.xml'));
  const document = zipText(zip, 'word/document.xml');
  if (!document) throw new DocumentError('word/document.xml is missing');
  const ctx: Context = {
    styles: readStyles(zipText(zip, 'word/styles.xml')),
    numbering: readNumbering(zipText(zip, 'word/numbering.xml')),
    footnotes: new Map(),
    used: [],
    shift: 0,
  };
  const titles = [...ctx.styles.headings].filter(([, level]) => level === 0).map(([id]) => id);
  if (titles.some((id) => document.includes(`w:val="${id}"`))) ctx.shift = 1;
  readNotes(zipText(zip, 'word/footnotes.xml'), 'w:footnote', '', ctx);
  readNotes(zipText(zip, 'word/endnotes.xml'), 'w:endnote', 'e', ctx);
  const body = find(parseMarkup(document), 'w:body');
  const out = body ? blocks(body, ctx) : [];
  if (ctx.used.length) out.push(ctx.used.map((id, i) => `[^${i + 1}]: ${ctx.footnotes.get(id)}`).join('\n'));
  return { markdown: joinBlocks(out), format: 'docx' };
}
