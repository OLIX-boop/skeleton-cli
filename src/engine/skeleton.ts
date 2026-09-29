import type { Node } from 'web-tree-sitter';
import { LANGUAGES, type LanguageId, type LanguageSpec } from '../languages/index.js';
import { getParser } from './parser.js';

export interface SkeletonOptions {
  /**
   * Marker text placed inside stripped bodies (default `...`). Each language wraps it in
   * syntax that keeps the output valid, e.g. `{ /* ... *\/ }` or `...`.
   */
  placeholder?: string;
}

export interface SkeletonResult {
  /** The transformed source. */
  code: string;
  /** Number of implementation bodies that were stripped. */
  strippedBodies: number;
  /** Whether the parser reported syntax errors (output is best-effort in that case). */
  hasErrors: boolean;
}

export const DEFAULT_PLACEHOLDER = '...';

interface Edit {
  start: number;
  end: number;
  text: string;
}

function collectEdits(source: string, root: Node, spec: LanguageSpec, placeholder: string): Edit[] {
  const edits: Edit[] = [];
  const stack: Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    const replacement = spec.bodyReplacement(node, placeholder);
    const skipId = replacement?.node.id;
    if (replacement) {
      const start = replacement.start ?? replacement.node.startIndex;
      const end = replacement.end ?? replacement.node.endIndex;
      // Already a placeholder (e.g. re-processing skeleton output): nothing to strip.
      if (source.slice(start, end) !== replacement.text) {
        edits.push({ start, end, text: replacement.text });
      }
    }
    // Keep walking the rest of the node (e.g. default parameter values may contain
    // closures), but never descend into a subtree that has been replaced.
    const children = node.children;
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i];
      if (child && child.id !== skipId) stack.push(child);
    }
  }
  return edits.sort((a, b) => a.start - b.start);
}

function applyEdits(source: string, edits: Edit[]): string {
  let out = '';
  let cursor = 0;
  for (const edit of edits) {
    if (edit.start < cursor) continue; // defensive: never apply overlapping edits
    out += source.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  return out + source.slice(cursor);
}

/**
 * Strip implementation bodies from `source`, keeping signatures, types, and structure.
 */
export async function skeletonize(
  source: string,
  language: LanguageId | LanguageSpec,
  options: SkeletonOptions = {},
): Promise<SkeletonResult> {
  const spec = typeof language === 'string' ? LANGUAGES[language] : language;
  const parser = await getParser(spec);
  const tree = parser.parse(source);
  if (!tree) throw new Error(`Failed to parse source as ${spec.id}`);
  try {
    const edits = collectEdits(source, tree.rootNode, spec, options.placeholder ?? DEFAULT_PLACEHOLDER);
    return {
      code: applyEdits(source, edits),
      strippedBodies: edits.length,
      hasErrors: tree.rootNode.hasError,
    };
  } finally {
    tree.delete();
  }
}
