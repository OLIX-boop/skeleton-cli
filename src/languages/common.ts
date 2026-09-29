import type { Node } from 'web-tree-sitter';
import type { BodyReplacement } from './types.js';

/** `{ /* text *\/ }` — a valid empty block in every C-family language. */
export function braceBlock(placeholder: string): string {
  return `{ /* ${placeholder} */ }`;
}

/** Whether a node spans more than one line. */
export function isMultiline(node: Node): boolean {
  return node.startPosition.row !== node.endPosition.row;
}

/**
 * Replace the text between `owner`'s first `{` token and its last `}` token with a
 * placeholder comment, e.g. `init { ... }` → `init { /* ... *\/ }`. Used where the grammar
 * has no dedicated body node. The whole owner subtree is skipped by the walker.
 */
export function innerBraces(owner: Node, placeholder: string, from?: Node | null): BodyReplacement | null {
  const children = owner.children;
  let open = -1;
  let close = -1;
  for (let i = 0; i < children.length; i++) {
    const type = children[i]?.type;
    if (type === '{' && open === -1) open = i;
    if (type === '}') close = i;
  }
  if (open === -1 || close <= open) return null;
  const start = from ? from.endIndex : children[open]!.endIndex;
  const end = children[close]!.startIndex;
  if (end < start) return null;
  return { node: owner, start, end, text: ` /* ${placeholder} */ ` };
}

/** Standard rule: replace the `body` field of the node with a brace block. */
export function bodyField(node: Node, placeholder: string, field = 'body'): BodyReplacement | null {
  const body = node.childForFieldName(field);
  return body ? { node: body, text: braceBlock(placeholder) } : null;
}
