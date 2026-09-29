import type { DependencyGraph } from '../deps.js';
import type { PackedFile, PackResult } from '../pack.js';

export type OutputFormat = 'markdown' | 'json' | 'xml';

export const OUTPUT_FORMATS: readonly OutputFormat[] = ['markdown', 'json', 'xml'];

export const OUTPUT_EXTENSIONS: Record<OutputFormat, string> = { markdown: 'md', json: 'json', xml: 'xml' };

export interface RenderOptions {
  /** Project name shown in the header (defaults to the root directory name). */
  projectName: string;
  /** Include the directory tree. Default true. */
  tree?: boolean;
  /** Free-form instructions placed at the top of the document (e.g. the task for the LLM). */
  instructions?: string;
  /** Focus targets, shown in the header. */
  focus?: readonly string[];
  /** Tool version, shown in the header. */
  version?: string;
  /** Internal import graph to include after the tree (from `--deps`). */
  dependencies?: DependencyGraph;
  /** A unified diff to include before the files (e.g. from `--diff`). */
  diff?: { ref: string; text: string };
  /**
   * Put the diff after the files instead, so that the start of the document stays the same
   * when only the working tree changes (for LLM prompt caches; used with `--order stable`).
   */
  diffLast?: boolean;
  /**
   * When the pack is split into several documents: this document's 1-based index, the total,
   * and every file of the pack (the tree, instructions and diff only appear in part 1).
   */
  part?: { index: number; total: number; allFiles: readonly PackedFile[] };
}

export interface Renderer {
  (result: PackResult, options: RenderOptions): string;
}
