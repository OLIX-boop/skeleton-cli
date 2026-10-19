/**
 * A small, tolerant XML/HTML parser: enough to walk Office Open XML, OpenDocument, EPUB and
 * web pages without a dependency. Not validating; malformed input yields a best-effort tree.
 */

export interface Element {
  name: string;
  attrs: Record<string, string>;
  children: Node[];
}

export type Node = Element | string;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', ndash: '–', mdash: '—', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', bull: '•', middot: '·', copy: '©',
  reg: '®', trade: '™', euro: '€', pound: '£', yen: '¥', cent: '¢', deg: '°', plusmn: '±', times: '×',
  divide: '÷', para: '¶', sect: '§', shy: '', zwj: '', zwnj: '', ensp: ' ', emsp: ' ', thinsp: ' ',
  agrave: 'à', aacute: 'á', egrave: 'è', eacute: 'é', igrave: 'ì', iacute: 'í', ograve: 'ò', oacute: 'ó',
  ugrave: 'ù', uacute: 'ú', Agrave: 'À', Egrave: 'È', Eacute: 'É', ccedil: 'ç', ntilde: 'ñ', auml: 'ä',
  ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß', larr: '←', rarr: '→', uarr: '↑', darr: '↓',
};

export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    return NAMED_ENTITIES[body] ?? match;
  });
}

const HTML_VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
/** Elements whose content is not markup. */
const HTML_RAW = new Set(['script', 'style', 'textarea', 'title']);
/** Opening one of these closes an open element of the same kind (`<p>a<p>b`, `<li>a<li>b`). */
const HTML_SELF_CLOSING_SIBLINGS = new Set(['p', 'li', 'tr', 'td', 'th', 'option', 'dt', 'dd']);

const ATTR = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

function parseAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of source.matchAll(ATTR)) attrs[m[1]!] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  return attrs;
}

/** Parse markup into a root element named `#document`. */
export function parseMarkup(source: string, options: { html?: boolean } = {}): Element {
  const html = options.html ?? false;
  const root: Element = { name: '#document', attrs: {}, children: [] };
  const stack: Element[] = [root];
  const top = () => stack[stack.length - 1]!;
  const fold = (name: string) => (html ? name.toLowerCase() : name);
  let i = 0;
  const pushText = (text: string) => {
    if (text) top().children.push(decodeEntities(text));
  };
  while (i < source.length) {
    const lt = source.indexOf('<', i);
    if (lt === -1) {
      pushText(source.slice(i));
      break;
    }
    pushText(source.slice(i, lt));
    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4);
      i = end === -1 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith('<![CDATA[', lt)) {
      const end = source.indexOf(']]>', lt + 9);
      top().children.push(source.slice(lt + 9, end === -1 ? source.length : end));
      i = end === -1 ? source.length : end + 3;
      continue;
    }
    if (source[lt + 1] === '?' || source[lt + 1] === '!') {
      const end = source.indexOf('>', lt);
      i = end === -1 ? source.length : end + 1;
      continue;
    }
    const end = findTagEnd(source, lt);
    if (end === -1) {
      pushText(source.slice(lt));
      break;
    }
    const raw = source.slice(lt + 1, end);
    i = end + 1;
    if (raw[0] === '/') {
      const name = fold(raw.slice(1).trim());
      // Close the nearest matching element; ignore stray closers.
      for (let s = stack.length - 1; s > 0; s--) {
        if (stack[s]!.name === name) {
          stack.length = s;
          break;
        }
      }
      continue;
    }
    const selfClosing = raw.endsWith('/');
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const space = body.search(/[\s/]/);
    const name = fold(space === -1 ? body : body.slice(0, space));
    if (!name || !/^[A-Za-z_:]/.test(name)) {
      pushText(`<${raw}>`);
      continue;
    }
    const element: Element = { name, attrs: space === -1 ? {} : parseAttrs(body.slice(space)), children: [] };
    if (html && HTML_SELF_CLOSING_SIBLINGS.has(name)) {
      for (let s = stack.length - 1; s > 0; s--) {
        const open = stack[s]!.name;
        if (open === name) {
          stack.length = s;
          break;
        }
        // Don't look past the container a sibling would belong to.
        if (open === 'ul' || open === 'ol' || open === 'table' || open === 'tbody' || open === 'div' || open === 'tr') break;
      }
    }
    top().children.push(element);
    if (selfClosing || (html && HTML_VOID.has(name))) continue;
    if (html && HTML_RAW.has(name)) {
      const close = source.toLowerCase().indexOf(`</${name}`, i);
      const stop = close === -1 ? source.length : close;
      element.children.push(name === 'title' || name === 'textarea' ? decodeEntities(source.slice(i, stop)) : source.slice(i, stop));
      const gt = close === -1 ? -1 : source.indexOf('>', close);
      i = gt === -1 ? source.length : gt + 1;
      continue;
    }
    stack.push(element);
  }
  return root;
}

/** Index of the `>` closing the tag that opens at `lt`, skipping quoted attribute values. */
function findTagEnd(source: string, lt: number): number {
  let quote = '';
  for (let j = lt + 1; j < source.length; j++) {
    const c = source[j]!;
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '>') {
      return j;
    } else if (c === '<' && j > lt + 1) {
      return -1;
    }
  }
  return -1;
}

/** Local name without a namespace prefix (`w:p` → `p`). */
export function local(name: string): string {
  const colon = name.indexOf(':');
  return colon === -1 ? name : name.slice(colon + 1);
}

export function isElement(node: Node | undefined): node is Element {
  return typeof node === 'object' && node !== null;
}

/** Direct child elements, optionally only those with this (qualified) name. */
export function childElements(element: Element, name?: string): Element[] {
  const out: Element[] = [];
  for (const child of element.children) if (isElement(child) && (name === undefined || child.name === name)) out.push(child);
  return out;
}

export function firstChild(element: Element, name: string): Element | undefined {
  for (const child of element.children) if (isElement(child) && child.name === name) return child;
  return undefined;
}

/** Depth-first search for the first descendant with this name. */
export function find(element: Element, name: string): Element | undefined {
  for (const child of element.children) {
    if (!isElement(child)) continue;
    if (child.name === name) return child;
    const hit = find(child, name);
    if (hit) return hit;
  }
  return undefined;
}

/** Every descendant with this name, in document order (not descending into matches). */
export function findAll(element: Element, name: string, out: Element[] = []): Element[] {
  for (const child of element.children) {
    if (!isElement(child)) continue;
    if (child.name === name) out.push(child);
    else findAll(child, name, out);
  }
  return out;
}

/** Concatenated text of all descendants. */
export function textOf(node: Node): string {
  if (!isElement(node)) return node;
  let out = '';
  for (const child of node.children) out += textOf(child);
  return out;
}
