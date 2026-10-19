import { posix } from 'node:path';
import { DocumentError, joinBlocks, markdownTable, readZip, squash, zipText, type ConvertedDocument } from './common.js';
import { childElements, find, findAll, firstChild, isElement, parseMarkup, textOf, type Element } from './markup.js';

/**
 * PowerPoint decks (`.pptx`): one section per slide, in presentation order, with the title,
 * text (bullets indented by level), tables, image descriptions and speaker notes.
 */

/** Relationship id → target path, resolved against the part's directory. */
function relationships(zip: Map<string, Uint8Array>, part: string): Map<string, string> {
  const dir = posix.dirname(part);
  const rels = zipText(zip, `${dir}/_rels/${posix.basename(part)}.rels`);
  const out = new Map<string, string>();
  if (!rels) return out;
  for (const rel of findAll(parseMarkup(rels), 'Relationship')) {
    const target = rel.attrs.Target;
    if (rel.attrs.Id && target && rel.attrs.TargetMode !== 'External') {
      out.set(rel.attrs.Id, target.startsWith('/') ? target.slice(1) : posix.normalize(posix.join(dir, target)));
    }
  }
  return out;
}

function placeholderType(shape: Element): string | undefined {
  return find(shape, 'p:ph')?.attrs.type;
}

/** Paragraphs of a text body, bullets indented by their level. */
function textBody(body: Element, bullets: boolean): string[] {
  const lines: string[] = [];
  for (const p of childElements(body, 'a:p')) {
    let text = '';
    for (const child of p.children) {
      if (!isElement(child)) continue;
      if (child.name === 'a:r' || child.name === 'a:fld') text += textOf(firstChild(child, 'a:t') ?? { name: '', attrs: {}, children: [] });
      else if (child.name === 'a:br') text += '\n';
    }
    text = squash(text);
    if (!text) continue;
    const level = Number(firstChild(p, 'a:pPr')?.attrs.lvl ?? 0);
    lines.push(bullets ? `${'  '.repeat(level)}- ${text.replace(/\n/g, ' ')}` : text);
  }
  return lines;
}

function slideTable(tbl: Element): string {
  return markdownTable(
    findAll(tbl, 'a:tr').map((tr) => childElements(tr, 'a:tc').map((tc) => textBody(firstChild(tc, 'a:txBody') ?? tc, false).join('\n'))),
  );
}

interface SlideContent {
  title: string;
  blocks: string[];
}

function shapes(container: Element, out: SlideContent): void {
  for (const child of container.children) {
    if (!isElement(child)) continue;
    if (child.name === 'p:sp') {
      const body = firstChild(child, 'p:txBody');
      if (!body) continue;
      const type = placeholderType(child);
      if (type === 'sldNum' || type === 'dt' || type === 'ftr') continue;
      if ((type === 'title' || type === 'ctrTitle') && !out.title) {
        out.title = squash(textBody(body, false).join(' '));
        continue;
      }
      // Body placeholders (`<p:ph idx="1"/>`, type body or obj) are bulleted; free text boxes usually aren't.
      const bulleted = !!find(child, 'p:ph') && (type === undefined || type === 'body' || type === 'obj');
      const lines = textBody(body, bulleted);
      if (lines.length) out.blocks.push(lines.join('\n'));
    } else if (child.name === 'p:graphicFrame') {
      const tbl = find(child, 'a:tbl');
      if (tbl) out.blocks.push(slideTable(tbl));
    } else if (child.name === 'p:pic') {
      const description = find(child, 'p:cNvPr')?.attrs.descr;
      out.blocks.push(description ? `[image: ${squash(description)}]` : '[image]');
    } else if (child.name === 'p:grpSp') {
      shapes(child, out);
    }
  }
}

export function convertPptx(bytes: Uint8Array): ConvertedDocument {
  const zip = readZip(bytes, (name) => name.startsWith('ppt/') && (name.endsWith('.xml') || name.endsWith('.rels')));
  const presentation = zipText(zip, 'ppt/presentation.xml');
  if (!presentation) throw new DocumentError('ppt/presentation.xml is missing');
  const rels = relationships(zip, 'ppt/presentation.xml');
  const slideParts = findAll(parseMarkup(presentation), 'p:sldId')
    .map((s) => rels.get(s.attrs['r:id'] ?? ''))
    .filter((p): p is string => !!p && zip.has(p));
  const sections: string[] = [];
  slideParts.forEach((part, index) => {
    const tree = find(parseMarkup(zipText(zip, part)!), 'p:spTree');
    const content: SlideContent = { title: '', blocks: [] };
    if (tree) shapes(tree, content);
    const notesPart = [...relationships(zip, part).values()].find((t) => /notesSlide\d*\.xml$/.test(t));
    const notesTree = notesPart && zipText(zip, notesPart) ? find(parseMarkup(zipText(zip, notesPart)!), 'p:spTree') : undefined;
    const notes: string[] = [];
    if (notesTree) {
      for (const sp of findAll(notesTree, 'p:sp')) {
        const type = placeholderType(sp);
        const body = firstChild(sp, 'p:txBody');
        if (body && (type === 'body' || type === undefined)) notes.push(...textBody(body, false));
      }
    }
    const blocks = [`## Slide ${index + 1}${content.title ? `: ${content.title}` : ''}`, ...content.blocks];
    if (notes.length) blocks.push(`> Notes: ${notes.join('\n> ')}`);
    sections.push(joinBlocks(blocks));
  });
  return { markdown: joinBlocks(sections), format: 'pptx', pages: slideParts.length };
}
