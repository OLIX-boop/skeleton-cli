import { basename } from 'node:path';
import { TokenCounter } from '../tokens/index.js';
import { DocumentError, type VisualPage } from './common.js';
import { condenseDocument, outlineDocument, pageCount, selectPages, selectSections } from './condense.js';
import { loadDocument, type LoadedDocument } from './index.js';

/**
 * Reading one document the way a model should: whole when it is small, otherwise its
 * outline, so the next request can name the section or pages it actually needs.
 */

export type ReadMode = 'auto' | 'full' | 'skeleton' | 'outline';

export interface ReadOptions {
  mode?: ReadMode;
  /** Only the sections whose heading contains this text. */
  section?: string;
  /** Only these 1-based pages (paginated formats). */
  pages?: readonly number[];
  /** Folder for saved transcriptions when the file is not inside a project. */
  root?: string;
  /** In `auto` mode, documents up to this many tokens are shown whole (default 6000). */
  autoFullTokens?: number;
}

export interface ReadResult {
  document: LoadedDocument;
  /** What was returned: the whole text, a condensed or outlined view, or a selection. */
  view: 'full' | 'skeleton' | 'outline' | 'section' | 'pages';
  text: string;
  /** Tokens of `text` and of the whole converted document (cl100k_base). */
  tokens: number;
  documentTokens: number;
  /** Visual pages in the returned part that have no transcription yet: they must be looked at. */
  pending: VisualPage[];
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function describe(doc: LoadedDocument, path: string, tokens: number): string {
  const parts = [basename(path), doc.format.toUpperCase()];
  if (doc.pages) parts.push(plural(doc.pages, doc.format === 'pptx' || doc.format === 'odp' ? 'slide' : doc.format === 'xlsx' || doc.format === 'ods' ? 'sheet' : 'page'));
  parts.push(`${tokens.toLocaleString('en-US')} tokens as text`);
  const pending = (doc.visualPages ?? []).filter((v) => !doc.transcribed.includes(v.page));
  if (pending.length) parts.push(`${plural(pending.length, 'page')} to look at as images (${pending.map((v) => v.page).join(', ')})`);
  if (doc.transcribed.length) parts.push(`${plural(doc.transcribed.length, 'page')} transcribed earlier`);
  if (doc.blankPages?.length) parts.push(`${plural(doc.blankPages.length, 'blank page')} left out`);
  return `[document: ${parts.join(' · ')}]`;
}

export async function readDocument(absPath: string, options: ReadOptions = {}): Promise<ReadResult> {
  const doc = await loadDocument(absPath, { root: options.root });
  const counter = new TokenCounter();
  try {
    const documentTokens = counter.count(doc.markdown);
    let view: ReadResult['view'];
    let body: string;
    let hint = '';
    let pagesInView: number[] | undefined;
    if (options.pages?.length) {
      const last = pageCount(doc.markdown) || doc.pages || 0;
      if (!last) throw new DocumentError(`${basename(absPath)} has no pages; use section instead`);
      const missing = options.pages.filter((p) => p < 1 || p > (doc.pages ?? last));
      if (missing.length) throw new DocumentError(`page ${missing[0]} does not exist (the document has ${doc.pages ?? last})`);
      view = 'pages';
      body = selectPages(doc.markdown, options.pages);
      pagesInView = [...options.pages];
      const blank = options.pages.filter((p) => doc.blankPages?.includes(p));
      if (blank.length) body += `${body ? '\n' : ''}[blank: page${blank.length === 1 ? '' : 's'} ${blank.join(', ')}]\n`;
    } else if (options.section) {
      const selected = selectSections(doc.markdown, options.section);
      if (!selected) {
        throw new DocumentError(`no heading contains "${options.section}". Headings:\n${outlineDocument(doc.markdown).trimEnd()}`);
      }
      view = 'section';
      body = selected;
      pagesInView = [...selected.matchAll(/^<!-- page (\d+)/gm)].map((m) => Number(m[1]));
    } else {
      const mode = options.mode ?? 'auto';
      const small = documentTokens <= (options.autoFullTokens ?? 6000);
      if (mode === 'full' || (mode === 'auto' && small)) {
        view = 'full';
        body = doc.markdown;
      } else if (mode === 'skeleton') {
        view = 'skeleton';
        body = condenseDocument(doc.markdown);
      } else {
        view = 'outline';
        body = outlineDocument(doc.markdown);
        const paginated = pageCount(doc.markdown) > 0;
        if (mode === 'auto') hint = `[shown as an outline because the full text is ${documentTokens.toLocaleString('en-US')} tokens: ask for a section by its heading${paginated ? ', or for pages' : ''}]\n`;
      }
    }
    const visual = (doc.visualPages ?? []).filter((v) => !doc.transcribed.includes(v.page));
    const pending = pagesInView === undefined ? (view === 'full' ? visual : []) : visual.filter((v) => pagesInView!.includes(v.page));
    const text = `${describe(doc, absPath, documentTokens)}\n${hint}\n${body}`;
    return { document: doc, view, text, tokens: counter.count(text), documentTokens, pending };
  } finally {
    counter.free();
  }
}
