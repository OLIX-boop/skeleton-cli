import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { cacheStore } from '../cache/store.js';
import { LruCache } from '../util/lru.js';
import { DocumentError, type ConvertedDocument } from './common.js';
import { convertDocx } from './docx.js';
import { convertEml } from './eml.js';
import { convertEpub } from './epub.js';
import { convertHtml } from './html.js';
import { convertOdf } from './odf.js';
import { convertPdf } from './pdf.js';
import { convertPptx } from './pptx.js';
import { convertRtf } from './rtf.js';
import { convertXlsx } from './xlsx.js';
import { contentHash, mergeTranscripts, readTranscripts, transcriptRoot } from './transcripts.js';

export { DocumentError, type ConvertedDocument, type VisualPage } from './common.js';
export { condenseDocument, outlineDocument, pageCount, parsePages, selectPages, selectSections } from './condense.js';
export { renderPdfPages, type RenderedPage } from './render.js';
export { contentHash, saveTranscripts, transcriptRoot, TRANSCRIPTS_DIR } from './transcripts.js';

/**
 * Documents astpack converts to Markdown: PDF, Office (Word, PowerPoint, Excel), OpenDocument,
 * EPUB, RTF and e-mail. HTML is converted only when asked for directly (`astpack doc`,
 * `read_document`): in a project it is usually source code.
 */

type Converter = (bytes: Uint8Array) => ConvertedDocument | Promise<ConvertedDocument>;

interface Format {
  id: string;
  convert: Converter;
  /** Converted when packing a directory (not just on direct request). */
  packed: boolean;
}

const FORMATS: Record<string, Format> = {};
function register(extensions: string[], id: string, convert: Converter, packed = true): void {
  for (const ext of extensions) FORMATS[ext] = { id, convert, packed };
}
register(['pdf'], 'pdf', convertPdf);
register(['docx', 'docm', 'dotx', 'dotm'], 'docx', convertDocx);
register(['pptx', 'pptm', 'ppsx', 'potx'], 'pptx', convertPptx);
register(['xlsx', 'xlsm', 'xltx', 'xltm'], 'xlsx', convertXlsx);
register(['odt', 'ott'], 'odt', (b) => convertOdf(b, 'odt'));
register(['ods', 'ots'], 'ods', (b) => convertOdf(b, 'ods'));
register(['odp', 'otp'], 'odp', (b) => convertOdf(b, 'odp'));
register(['epub'], 'epub', convertEpub);
register(['rtf'], 'rtf', convertRtf);
register(['eml'], 'eml', convertEml);
register(['html', 'htm', 'xhtml'], 'html', convertHtml, false);

function extension(path: string): string {
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1).toLowerCase();
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1);
}

/** The document format of a path, or `undefined`. `direct` also accepts formats only converted on request (HTML). */
export function documentFormat(path: string, direct = false): string | undefined {
  const format = FORMATS[extension(path)];
  return format && (direct || format.packed) ? format.id : undefined;
}

/** Whether packing a directory converts this file as a document. */
export function isDocument(path: string): boolean {
  return documentFormat(path) !== undefined;
}

/** Extensions packing converts (used by the walker to let them through its binary filter). */
export const PACKED_DOCUMENT_EXTENSIONS = Object.entries(FORMATS)
  .filter(([, f]) => f.packed)
  .map(([ext]) => ext);

/** Bump when conversion output changes, so cached conversions are redone. */
const CONVERTER_VERSION = 1;

const memory = new LruCache<string, ConvertedDocument>(2000, 128 * 1024 * 1024, (d) => d.markdown.length * 2 + 512);

/** Convert a document's bytes to Markdown (cached in memory and in the on-disk cache). */
export async function convertDocument(path: string, bytes: Uint8Array, direct = true): Promise<ConvertedDocument> {
  const ext = extension(path);
  const format = FORMATS[ext];
  if (!format || (!direct && !format.packed)) throw new DocumentError(`unsupported document type: .${ext}`);
  const key = createHash('sha1').update(`${CONVERTER_VERSION}\0${format.id}\0`).update(bytes).digest('base64');
  const cached = memory.get(key) ?? cacheStore()?.get<ConvertedDocument>('document', key);
  if (cached) {
    memory.set(key, cached);
    cacheStore()?.set('document', key, cached);
    return cached;
  }
  let result: ConvertedDocument;
  try {
    result = await format.convert(bytes);
  } catch (error) {
    if (error instanceof DocumentError) throw error;
    throw new DocumentError(`cannot read ${format.id.toUpperCase()}: ${(error as Error).message}`);
  }
  memory.set(key, result);
  cacheStore()?.set('document', key, result);
  return result;
}

export interface LoadedDocument extends ConvertedDocument {
  /** Content hash, the key of the document's transcriptions. */
  hash: string;
  /** Project folder holding the transcriptions. */
  transcriptRoot: string;
  /** Pages whose transcription is included in `markdown`. */
  transcribed: number[];
  bytes: Uint8Array;
}

/** Read, convert and merge saved transcriptions into a document. */
export async function loadDocument(absPath: string, options: { root?: string; direct?: boolean } = {}): Promise<LoadedDocument> {
  const bytes = await readFile(absPath);
  const converted = await convertDocument(absPath, bytes, options.direct ?? true);
  const hash = contentHash(bytes);
  const root = transcriptRoot(absPath, options.root);
  let markdown = converted.markdown;
  const transcribed: number[] = [];
  if (converted.visualPages?.length) {
    const transcripts = await readTranscripts(root, hash);
    markdown = mergeTranscripts(markdown, converted.visualPages, transcripts);
    for (const v of converted.visualPages) if (transcripts[String(v.page)]?.trim()) transcribed.push(v.page);
  }
  return { ...converted, markdown, hash, transcriptRoot: root, transcribed, bytes };
}
