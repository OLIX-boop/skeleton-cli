import type { Node } from 'web-tree-sitter';
import { LANGUAGES, type LanguageId, type LanguageSpec } from '../languages/index.js';
import type { CommentMode, RuleContext } from '../languages/types.js';
import { COMMENT_TYPE, isDirective, isDocComment, removalSpan } from './comments.js';
import { parseSource } from './parser.js';

export interface SkeletonOptions {
  /**
   * Marker text placed inside stripped bodies (default `...`). Each language wraps it in
   * syntax that keeps the output valid, e.g. `{ /* ... *\/ }` or `...`.
   */
  placeholder?: string;
  /** Strip implementation bodies. Default true; false only applies `comments`. */
  bodies?: boolean;
  /** Which comments to keep: `all` (default), `docs` (documentation only) or `none`. */
  comments?: CommentMode;
}

export interface SkeletonResult {
  /** The transformed source. */
  code: string;
  /** Number of implementation bodies that were stripped. */
  strippedBodies: number;
  /** Number of comments (and docstrings) that were removed. */
  strippedComments: number;
  /** Whether the parser reported syntax errors (output is best-effort in that case). */
  hasErrors: boolean;
}

export const DEFAULT_PLACEHOLDER = '...';

interface Edit {
  start: number;
  end: number;
  text: string;
}

interface Collected {
  edits: Edit[];
  bodies: number;
  comments: number;
}

function collectEdits(source: string, root: Node, spec: LanguageSpec, context: RuleContext, bodies: boolean): Collected {
  const edits: Edit[] = [];
  let bodyCount = 0;
  let commentCount = 0;
  const candidates = candidateSet(spec);
  const docCandidates = context.comments === 'none' && spec.docCandidates ? new Set(spec.docCandidates) : undefined;
  const cursor = root.walk();
  // Span of the most recent replacement: nodes inside it are not visited. A pre-order walk
  // visits nodes in document order, so only the latest replacement can contain the cursor.
  let skipStart = -1;
  let skipEnd = -1;

  const push = (start: number, end: number, text: string) => {
    edits.push({ start, end, text });
    skipStart = start;
    skipEnd = end;
  };

  try {
    for (;;) {
      let descend = true;
      const start = cursor.startIndex;
      const end = cursor.endIndex;
      const type = cursor.nodeType;
      if (start >= skipStart && end <= skipEnd && end > start) {
        descend = false;
      } else if (context.comments !== 'all' && COMMENT_TYPE.test(type)) {
        descend = false;
        const node = cursor.currentNode;
        const text = node.text;
        const keep = isDirective(text) || (context.comments === 'docs' && isDocComment(node, source, candidates));
        if (!keep) {
          const span = removalSpan(source, start, end);
          push(span.start, span.end, '');
          commentCount++;
        }
      } else if (docCandidates?.has(type)) {
        const node = cursor.currentNode;
        const replacement = spec.docReplacement?.(node);
        if (replacement !== undefined) {
          descend = false;
          if (replacement === '') {
            const span = removalSpan(source, start, end);
            push(span.start, span.end, '');
          } else {
            push(start, end, replacement);
          }
          commentCount++;
        }
      } else if (bodies && candidates.has(type)) {
        const node = cursor.currentNode;
        const replacement = spec.bodyReplacement(node, context.placeholder, context);
        if (replacement) {
          const editStart = replacement.start ?? replacement.node.startIndex;
          let editEnd = replacement.end ?? replacement.node.endIndex;
          // Some grammars include the trailing newline in a body (Scala's indented blocks);
          // never swallow it, or the next line would be glued onto the placeholder.
          if (replacement.end === undefined) {
            while (editEnd > editStart && /\s/.test(source[editEnd - 1]!)) editEnd--;
          }
          // Already a placeholder (e.g. re-processing skeleton output): nothing to strip.
          if (source.slice(editStart, editEnd) !== replacement.text) {
            edits.push({ start: editStart, end: editEnd, text: replacement.text });
            bodyCount++;
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
        if (!cursor.gotoParent()) {
          return { edits: edits.sort((a, b) => a.start - b.start), bodies: bodyCount, comments: commentCount };
        }
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
  const { tree, text: parsed } = await parseSource(spec, source);
  try {
    const context: RuleContext = { placeholder: options.placeholder ?? DEFAULT_PLACEHOLDER, comments: options.comments ?? 'all' };
    // Edits are computed on the parsed text and applied to the original, whose offsets match.
    const collected = collectEdits(parsed, tree.rootNode, spec, context, options.bodies ?? true);
    return {
      code: applyEdits(source, collected.edits),
      strippedBodies: collected.bodies,
      strippedComments: collected.comments,
      hasErrors: tree.rootNode.hasError,
    };
  } finally {
    tree.delete();
  }
}
