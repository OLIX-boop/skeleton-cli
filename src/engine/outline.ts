import type { Node } from 'web-tree-sitter';
import { LANGUAGES, type LanguageId, type LanguageSpec } from '../languages/index.js';
import { parseSource } from './parser.js';

export interface OutlineResult {
  /** One line per symbol, nested members indented by two spaces. */
  text: string;
  symbols: number;
  hasErrors: boolean;
}

const MAX_LINE = 240;

/** Collapse a declaration header to one tidy line. */
function tidy(text: string): string {
  let line = text
    .replace(/\s+/g, ' ')
    // Collapsed multi-line parameter lists: `( a, b, )` -> `(a, b)`.
    .replace(/([([])\s+/g, '$1')
    .replace(/,?\s+([)\]])/g, '$1')
    .trim();
  // Strip trailing block openers repeatedly: `type Foo = {` -> `type Foo`.
  for (let prev = ''; prev !== line; ) {
    prev = line;
    line = line.replace(/\s*(\{|:|=|;|\bdo|\bwhere|\bbegin)\s*$/u, '').trim();
  }
  return line.length > MAX_LINE ? `${line.slice(0, MAX_LINE - 1)}…` : line;
}

/** Start offset of the line containing `index`, so modifiers like `export` are included. */
function lineStart(source: string, index: number): number {
  return source.lastIndexOf('\n', index - 1) + 1;
}

/** The node holding a container's members (class body, declaration list, block…). */
function containerBody(node: Node): Node | null {
  const body = node.childForFieldName('body');
  if (body) return body;
  for (const child of node.namedChildren) {
    if (child && /(body|declaration_list|block|members|do_block)$/.test(child.type)) return child;
  }
  return null;
}

const BODY_LIKE = /(body|declaration_list|block|program|module|source_file|translation_unit|compilation_unit|statements)$/;

/**
 * Where a declaration's header starts: the beginning of its line (to include modifiers such
 * as `export` or `pub`), but never before the end of whatever precedes it on that line.
 */
function headerStart(source: string, node: Node): number {
  const start = lineStart(source, node.startIndex);
  let outer = node;
  while (outer.parent && !BODY_LIKE.test(outer.parent.type) && outer.parent.startIndex >= start) outer = outer.parent;
  // Named siblings only: `export` in `@Dec() export class …` is an anonymous token.
  const previous = outer.previousNamedSibling;
  // The first member of a one-line body (`trait T { fn m(); }`) starts after the body opens.
  const opener = !previous && outer.parent && BODY_LIKE.test(outer.parent.type) ? outer.parent.firstChild : null;
  const floor = previous ? previous.endIndex : opener && !opener.isNamed ? opener.endIndex : -1;
  return Math.max(start, floor);
}

const COMMENT_TYPES = ['comment', 'line_comment', 'block_comment', 'multiline_comment', 'documentation_comment'];

/** `source[start, end)` with any comments inside the declaration cut out. */
function withoutComments(source: string, node: Node, start: number, end: number): string {
  const comments = node.descendantsOfType(COMMENT_TYPES).filter((c): c is Node => !!c && c.startIndex >= start && c.endIndex <= end);
  // Python puts a comment after `def f():` as a sibling that precedes the body.
  for (let sib = node.firstChild; sib; sib = sib.nextSibling) {
    if (COMMENT_TYPES.includes(sib.type) && sib.startIndex >= start && sib.endIndex <= end && !comments.some((c) => c.id === sib!.id)) {
      comments.push(sib);
    }
  }
  if (!comments.length) return source.slice(start, end);
  comments.sort((a, b) => a.startIndex - b.startIndex);
  let out = '';
  let cursor = start;
  for (const c of comments) {
    if (c.startIndex < cursor) continue;
    out += `${source.slice(cursor, c.startIndex)} `;
    cursor = c.endIndex;
  }
  return out + source.slice(cursor, end);
}

function headerFrom(source: string, node: Node, end: number): string {
  const start = headerStart(source, node);
  return tidy(withoutComments(source, node, start, Math.max(end, node.startIndex)));
}

function firstLine(source: string, node: Node): string {
  const start = headerStart(source, node);
  const nl = source.indexOf('\n', node.startIndex);
  return tidy(withoutComments(source, node, start, nl === -1 || nl > node.endIndex ? node.endIndex : nl));
}

/**
 * Where a function's signature ends: at the body the skeletonizer would replace, or — for
 * bodies it leaves alone (stubs, `pass`, one-line arrows) — at the body node itself.
 */
function signatureEnd(node: Node, spec: LanguageSpec, context: { placeholder: string; comments: 'all' }): number | undefined {
  const replacement = spec.bodyReplacement(node, '...', context);
  if (replacement) return replacement.start ?? replacement.node.startIndex;
  if (node.type === 'function_body') return node.startIndex; // Dart
  const body = node.childForFieldName('body');
  if (!body) return undefined;
  // One-line arrow functions: keep `(u) =>` rather than cutting before the arrow.
  const arrow = body.previousSibling;
  return arrow?.type === '=>' ? arrow.endIndex : body.startIndex;
}

/**
 * Build a symbol outline: containers (classes, interfaces, modules, impls…) as headers with
 * their members nested, functions and methods as single-line signatures, and other
 * declarations (type aliases, enums…) as their first line.
 */
export function outlineTree(source: string, root: Node, spec: LanguageSpec): { lines: string[] } {
  const lines: string[] = [];
  const functions = new Set(spec.candidates);
  const containers = new Set(spec.outline?.containers ?? []);
  const declarations = new Set(spec.outline?.declarations ?? []);
  const members = new Set(spec.outline?.members ?? []);
  const context = { placeholder: '...', comments: 'all' as const };

  const visit = (node: Node, depth: number) => {
    const indent = '  '.repeat(depth);
    const isContainer = containers.has(node.type) || spec.outline?.isContainer?.(node);
    if (isContainer) {
      const body = containerBody(node);
      lines.push(indent + (body ? headerFrom(source, node, body.startIndex) : firstLine(source, node)));
      if (body) for (const child of body.namedChildren) if (child) visit(child, depth + 1);
      return;
    }
    if (functions.has(node.type)) {
      const end = signatureEnd(node, spec, context);
      if (end !== undefined) {
        // Dart keeps the signature in a sibling node before the body.
        const headerNode = node.type === 'function_body' && node.previousNamedSibling ? node.previousNamedSibling : node;
        lines.push(indent + headerFrom(source, headerNode, end));
        return; // nested functions are implementation details
      }
    }
    const label = spec.outline?.label?.(node, depth, source);
    if (label !== undefined) {
      if (label) lines.push(indent + tidy(label));
      return;
    }
    if (declarations.has(node.type) || (depth > 0 && members.has(node.type))) {
      lines.push(indent + firstLine(source, node));
      return;
    }
    for (const child of node.namedChildren) if (child) visit(child, depth);
  };
  visit(root, 0);
  // Drop empty lines and exact consecutive duplicates (e.g. overload + implementation).
  return { lines: lines.filter((l, i) => l.trim() && l !== lines[i - 1]) };
}

/** Outline `source` in the given language. */
export async function outline(source: string, language: LanguageId | LanguageSpec): Promise<OutlineResult> {
  const spec = typeof language === 'string' ? LANGUAGES[language] : language;
  const { tree, text } = await parseSource(spec, source);
  try {
    const { lines } = outlineTree(text, tree.rootNode, spec);
    return { text: lines.length ? `${lines.join('\n')}\n` : '', symbols: lines.length, hasErrors: tree.rootNode.hasError };
  } finally {
    tree.delete();
  }
}
