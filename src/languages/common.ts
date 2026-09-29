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

function blankLine(line: string): string {
  return line.replace(/[^\r\n]/g, ' ');
}

/**
 * Build a `LanguageSpec.preprocess` that resolves conditional compilation the way a compiler
 * would with one set of symbols: keep the first branch of each `#if` chain and blank the
 * other branches and every directive line. `directive` matches a directive line and captures
 * its name; `if`, `elif`/`elseif`/`else` and `endif` drive the branches, any other name is
 * only blanked. Blanked text keeps its length and line breaks, so offsets stay valid.
 */
export function conditionalBlanker(directive: RegExp): (source: string) => string {
  return (source) => {
    // One entry per open `#if`: whether its current branch is inactive.
    const stack: boolean[] = [];
    return source
      .split(/(?<=\n)/)
      .map((line) => {
        const name = directive.exec(line)?.[1];
        if (name === 'if') stack.push(false);
        else if ((name === 'elif' || name === 'elseif' || name === 'else') && stack.length > 0) stack[stack.length - 1] = true;
        else if (name === 'endif') stack.pop();
        return name || stack.includes(true) ? blankLine(line) : line;
      })
      .join('');
  };
}
