import { renderTree } from './tree.js';
import { contentFiles, legend, treeNotes } from './common.js';
import type { Renderer } from './types.js';

export interface JsonDocument {
  project: string;
  tool: { name: 'astpack'; version?: string };
  mode: string;
  focus: string[];
  notes: string;
  instructions?: string;
  tree?: string;
  diff?: { ref: string; text: string };
  dependencies?: Record<string, string[]>;
  part?: { index: number; total: number };
  files: {
    path: string;
    language: string | null;
    strategy: string;
    focused: boolean;
    /** Focused only because it imports, or is imported by, a focus target. */
    related?: boolean;
    size: number;
    strippedBodies: number;
    content: string;
  }[];
  skipped: { path: string; reason: string }[];
}

export function toJsonDocument(...[result, options]: Parameters<Renderer>): JsonDocument {
  const part = options.part;
  const first = !part || part.index === 1;
  const whole = part ? { ...result, files: [...part.allFiles] } : result;
  return {
    project: options.projectName,
    tool: { name: 'astpack', version: options.version },
    mode: result.mode,
    focus: [...(options.focus ?? [])],
    notes: legend(whole),
    ...(part ? { part: { index: part.index, total: part.total } } : {}),
    ...(first && options.instructions?.trim() ? { instructions: options.instructions.trim() } : {}),
    ...(first && options.tree !== false ? { tree: renderTree(whole.files.map((f) => f.path), treeNotes(whole)) } : {}),
    ...(first && options.dependencies?.size ? { dependencies: Object.fromEntries(options.dependencies) } : {}),
    ...(first && options.diff?.text.trim() ? { diff: options.diff } : {}),
    files: contentFiles(result).map((f) => ({
      path: f.path,
      language: f.language ?? null,
      strategy: f.strategy,
      focused: f.focused,
      ...(f.related ? { related: true } : {}),
      size: f.size,
      strippedBodies: f.strippedBodies,
      content: f.content,
    })),
    skipped: result.skipped.map((s) => ({ path: s.path, reason: s.reason })),
  };
}

export const renderJson: Renderer = (result, options) => `${JSON.stringify(toJsonDocument(result, options), null, 2)}\n`;
