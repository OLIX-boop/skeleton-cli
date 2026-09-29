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
  const candidates = candidateSet(spec);
  const cursor = root.walk();
  // Span of the most recent replacement: nodes inside it are not visited. A pre-order walk
  // visits nodes in document order, so only the latest replacement can contain the cursor.
  let skipStart = -1;
  let skipEnd = -1;
  try {
    for (;;) {
      let descend = true;
      const start = cursor.startIndex;
      const end = cursor.endIndex;
      if (start >= skipStart && end <= skipEnd && end > start) {
        descend = false;
      } else if (candidates.has(cursor.nodeType)) {
        const node = cursor.currentNode;
        const replacement = spec.bodyReplacement(node, placeholder);
        if (replacement) {
          const editStart = replacement.start ?? replacement.node.startIndex;
          const editEnd = replacement.end ?? replacement.node.endIndex;
          // Already a placeholder (e.g. re-processing skeleton output): nothing to strip.
          if (source.slice(editStart, editEnd) !== replacement.text) {
            edits.push({ start: editStart, end: editEnd, text: replacement.text });
          }
          // Keep walking the rest of the node (e.g. default parameter values may contain
          // closures), but never descend into the replaced span.
          skipStart = replacement.node.startIndex;
          skipEnd = replacement.node.endIndex;
          if (replacement.node.id === node.id) descend = false;
        }
      }
      if (descend && cursor.gotoFirstChild()) continue;
      while (!cursor.gotoNextSibling()) {
        if (!cursor.gotoParent()) return edits.sort((a, b) => a.start - b.start);
      }
    }
  } finally {
    cursor.delete();
  }
}

const candidateSets = new WeakMap<LanguageSpec, ReadonlySet<string>>();

function candidateSet(spec: LanguageSpec): ReadonlySet<string> {
  let set = candidateSets.get(spec);
  if (!set) {
    set = new Set(spec.candidates);
    candidateSets.set(spec, set);
  }
  return set;
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
