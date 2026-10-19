import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, join, parse } from 'node:path';
import { visualNote } from './pdf.js';
import type { VisualPage } from './common.js';

/**
 * Transcriptions of visual pages (handwriting, scans), written once by a model that looked at
 * the page images and reused from then on as plain text. They live in the project, under
 * `.astpack/transcripts/`, keyed by a hash of the document's content: commit the folder and
 * the transcriptions follow the project to other machines; edit the document and its old
 * transcriptions no longer apply.
 */

export const TRANSCRIPTS_DIR = join('.astpack', 'transcripts');

export interface TranscriptFile {
  /** Name of the document when it was transcribed (informative only). */
  file: string;
  /** 1-based page number → text. */
  pages: Record<string, string>;
  updated: string;
}

export function contentHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 24);
}

/**
 * Where a document's transcriptions are kept: the nearest folder above it that has an
 * `.astpack` or `.git` folder (the project), else `fallback`, else the document's folder.
 */
export function transcriptRoot(documentPath: string, fallback?: string): string {
  let dir = dirname(documentPath);
  for (;;) {
    if (existsSync(join(dir, '.astpack')) || existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir || dir === parse(dir).root) break;
    dir = parent;
  }
  return fallback ?? dirname(documentPath);
}

function transcriptPath(root: string, hash: string): string {
  return join(root, TRANSCRIPTS_DIR, `${hash}.json`);
}

export async function readTranscripts(root: string, hash: string): Promise<Record<string, string>> {
  try {
    const data = JSON.parse(await readFile(transcriptPath(root, hash), 'utf8')) as TranscriptFile;
    return data && typeof data.pages === 'object' ? data.pages : {};
  } catch {
    return {};
  }
}

/** Add (or replace) page transcriptions. Returns the file written. */
export async function saveTranscripts(root: string, hash: string, documentPath: string, pages: Record<string, string>): Promise<string> {
  const path = transcriptPath(root, hash);
  const existing = await readTranscripts(root, hash);
  const data: TranscriptFile = { file: basename(documentPath), pages: { ...existing, ...pages }, updated: new Date().toISOString() };
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`);
  await rename(temp, path);
  return path;
}

/** Put transcriptions in place of the notes about the visual pages they cover. */
export function mergeTranscripts(markdown: string, visualPages: readonly VisualPage[], transcripts: Record<string, string>): string {
  let out = markdown;
  for (const visual of visualPages) {
    const text = transcripts[String(visual.page)]?.trim();
    if (!text) continue;
    const note = visualNote(visual);
    const replacement = `[page ${visual.page}: ${visual.mixed ? 'handwriting or images' : visual.kind === 'ink' ? 'handwriting or drawing' : 'scan'}, transcribed]\n\n${text}`;
    out = out.includes(note) ? out.replace(note, () => replacement) : out;
  }
  return out;
}
