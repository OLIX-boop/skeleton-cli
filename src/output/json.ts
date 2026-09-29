import { renderTree } from './tree.js';
import { legend, treeNotes } from './common.js';
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
  files: {
    path: string;
    language: string | null;
    strategy: string;
    focused: boolean;
    size: number;
    strippedBodies: number;
    content: string;
  }[];
  skipped: { path: string; reason: string }[];
}

export function toJsonDocument(...[result, options]: Parameters<Renderer>): JsonDocument {
  return {
    project: options.projectName,
    tool: { name: 'astpack', version: options.version },
    mode: result.mode,
    focus: [...(options.focus ?? [])],
    notes: legend(result),
    ...(options.instructions?.trim() ? { instructions: options.instructions.trim() } : {}),
    ...(options.tree !== false ? { tree: renderTree(result.files.map((f) => f.path), treeNotes(result)) } : {}),
    ...(options.diff?.text.trim() ? { diff: options.diff } : {}),
    files: result.files.map((f) => ({
      path: f.path,
      language: f.language ?? null,
      strategy: f.strategy,
      focused: f.focused,
      size: f.size,
      strippedBodies: f.strippedBodies,
      content: f.content,
    })),
    skipped: result.skipped.map((s) => ({ path: s.path, reason: s.reason })),
  };
}

export const renderJson: Renderer = (result, options) => `${JSON.stringify(toJsonDocument(result, options), null, 2)}\n`;
