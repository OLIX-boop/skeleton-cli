import { posix } from 'node:path';
import { DocumentError, joinBlocks, readZip, utf8, zipText, type ConvertedDocument } from './common.js';
import { find, findAll, parseMarkup, textOf } from './markup.js';
import { htmlToMarkdown } from './html.js';

/** E-books (`.epub`): the chapters in reading order (the OPF spine), each converted from XHTML. */
export function convertEpub(bytes: Uint8Array): ConvertedDocument {
  const zip = readZip(bytes, (name) => !/\.(png|jpe?g|gif|svg|webp|ttf|otf|woff2?|mp3|mp4|css)$/i.test(name));
  const container = zipText(zip, 'META-INF/container.xml');
  const opfPath = container ? find(parseMarkup(container), 'rootfile')?.attrs['full-path'] : undefined;
  const opf = opfPath ? zipText(zip, opfPath) : undefined;
  if (!opfPath || !opf) throw new DocumentError('no OPF package document');
  const root = parseMarkup(opf);
  const dir = posix.dirname(opfPath);
  const manifest = new Map<string, string>();
  for (const item of findAll(root, 'item')) {
    if (item.attrs.id && item.attrs.href) manifest.set(item.attrs.id, posix.normalize(posix.join(dir, decodeURIComponent(item.attrs.href))));
  }
  const title = textOf(find(root, 'dc:title') ?? { name: '', attrs: {}, children: [] }).trim();
  const author = textOf(find(root, 'dc:creator') ?? { name: '', attrs: {}, children: [] }).trim();
  const chapters: string[] = [];
  for (const ref of findAll(root, 'itemref')) {
    if (ref.attrs.linear === 'no') continue;
    const part = manifest.get(ref.attrs.idref ?? '');
    const data = part ? zip.get(part) : undefined;
    if (!data) continue;
    const markdown = htmlToMarkdown(utf8(data), { keepChrome: true });
    if (markdown.trim()) chapters.push(markdown);
  }
  const header = [title ? `# ${title}` : '', author ? `*${author}*` : ''];
  return { markdown: joinBlocks([...header, ...chapters]), format: 'epub', pages: chapters.length };
}
