import { heading, joinBlocks, markdownTable, squash, type ConvertedDocument } from './common.js';
import { childElements, find, findAll, isElement, parseMarkup, textOf, type Element, type Node } from './markup.js';

/**
 * HTML to Markdown: headings, paragraphs, lists, tables, code blocks and quotes. Scripts,
 * styles, navigation, forms and page chrome are dropped; links keep only their text (URLs
 * cost tokens and rarely matter to the reader).
 */

const DROP = new Set(['script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'object', 'nav', 'form', 'button', 'select', 'input', 'head', 'title', 'aside', 'footer']);
const BLOCK = new Set(['p', 'div', 'section', 'article', 'main', 'header', 'figure', 'figcaption', 'address', 'center', 'dl', 'dt', 'dd', 'details', 'summary', 'body', 'html', 'hgroup', 'fieldset', 'caption']);

interface Options {
  /** Keep `<header>`/`<footer>`-style chrome (in EPUB chapters it is content). */
  keepChrome?: boolean;
}

function inline(node: Node, options: Options): string {
  if (!isElement(node)) return node;
  const name = node.name;
  if (DROP.has(name) && !(options.keepChrome && (name === 'footer' || name === 'aside'))) return '';
  if (name === 'br') return '\n';
  if (name === 'img') return node.attrs.alt ? ` [image: ${squash(node.attrs.alt)}] ` : '';
  if (name === 'code' || name === 'kbd' || name === 'samp') {
    const text = textOf(node);
    return text.includes('`') ? text : `\`${text}\``;
  }
  if (name === 'sup' && /^\d+$/.test(textOf(node).trim())) return `[^${textOf(node).trim()}]`;
  let out = '';
  for (const child of node.children) out += inline(child, options);
  return out;
}

function listBlock(list: Element, depth: number, options: Options): string {
  const ordered = list.name === 'ol';
  const lines: string[] = [];
  for (const li of childElements(list)) {
    if (li.name !== 'li') continue;
    let text = '';
    const nested: string[] = [];
    for (const child of li.children) {
      if (isElement(child) && (child.name === 'ul' || child.name === 'ol')) nested.push(listBlock(child, depth + 1, options));
      else if (isElement(child) && (child.name === 'p' || child.name === 'div')) text += ` ${inline(child, options)} `;
      else text += inline(child, options);
    }
    const clean = squash(text).replace(/\n+/g, ' ');
    if (clean) lines.push(`${'  '.repeat(depth)}${ordered ? '1.' : '-'} ${clean}`);
    lines.push(...nested.filter(Boolean));
  }
  return lines.join('\n');
}

function tableBlock(table: Element, options: Options): string {
  const rows = findAll(table, 'tr').map((tr) =>
    childElements(tr)
      .filter((c) => c.name === 'td' || c.name === 'th')
      .map((c) => inline(c, options)),
  );
  return markdownTable(rows);
}

function blocks(element: Element, options: Options, out: string[]): void {
  let buffer = '';
  const flush = () => {
    const text = squash(buffer);
    if (text) out.push(text);
    buffer = '';
  };
  for (const child of element.children) {
    if (!isElement(child)) {
      buffer += child;
      continue;
    }
    const name = child.name;
    if (DROP.has(name) && !(options.keepChrome && (name === 'footer' || name === 'aside'))) continue;
    const level = /^h([1-6])$/.exec(name);
    if (level) {
      flush();
      out.push(heading(Number(level[1]), inline(child, options)));
    } else if (name === 'ul' || name === 'ol') {
      flush();
      out.push(listBlock(child, 0, options));
    } else if (name === 'table') {
      flush();
      out.push(tableBlock(child, options));
    } else if (name === 'pre') {
      flush();
      const text = textOf(child).replace(/^\n/, '').replace(/\s+$/, '');
      const language = /language-([\w+-]+)/.exec(find(child, 'code')?.attrs.class ?? '')?.[1] ?? '';
      if (text) out.push(`\`\`\`${language}\n${text}\n\`\`\``);
    } else if (name === 'blockquote') {
      flush();
      const inner: string[] = [];
      blocks(child, options, inner);
      if (inner.length) out.push(inner.join('\n\n').replace(/^/gm, '> '));
    } else if (name === 'hr') {
      flush();
      out.push('---');
    } else if (BLOCK.has(name) || name === 'li') {
      flush();
      blocks(child, options, out);
    } else {
      buffer += inline(child, options);
    }
  }
  flush();
}

/** The readable part of a page: `<main>` or `<article>` when there is one, else `<body>`. */
function contentRoot(root: Element): Element {
  return find(root, 'main') ?? (findAll(root, 'article').length === 1 ? find(root, 'article') : undefined) ?? find(root, 'body') ?? root;
}

export function htmlToMarkdown(html: string, options: Options = {}): string {
  const root = parseMarkup(html, { html: true });
  const out: string[] = [];
  blocks(contentRoot(root), options, out);
  return joinBlocks(out);
}

export function htmlTitle(html: string): string | undefined {
  const title = find(parseMarkup(html, { html: true }), 'title');
  const text = title && squash(textOf(title));
  return text || undefined;
}

export function convertHtml(bytes: Uint8Array): ConvertedDocument {
  const html = new TextDecoder('utf-8').decode(bytes);
  const title = htmlTitle(html);
  const body = htmlToMarkdown(html);
  const markdown = title && !body.startsWith('# ') ? joinBlocks([`# ${title}`, body]) : body;
  return { markdown, format: 'html' };
}
