import type { Node } from 'web-tree-sitter';

/** Matches comment node types across grammars: comment, line_comment, block_comment, ... */
export const COMMENT_TYPE = /(^|_)comment$/;

/** Comments that change tooling behaviour and must survive stripping. */
const DIRECTIVE = /^(#!|\/\/go:|\/\/ ?\+build|\/\/\/ ?<reference|# ?-\*-|#\s*(frozen_string_literal|encoding|coding)[:=]|\/\/ ?@ts-|\/\* ?eslint|# ?type:|# ?noqa|# ?pragma|\/\/ ?swift-tools-version)/;

/** Documentation syntax: JSDoc/Javadoc/KDoc, Rust/C#/Dart/Swift doc comments. */
const DOC_SYNTAX = /^(\/\*\*(?!\/)|\/\*!|\/\/\/|\/\/!)/;

export function isDirective(text: string): boolean {
  return DIRECTIVE.test(text);
}

/** Heuristic: most lines of the comment end like code (`;`, `{`, `}`, `)`, `,`). */
export function looksLikeCode(text: string): boolean {
  const lines = text
    .replace(/^\s*(\/\*+|\/\/+|#+)/, '')
    .replace(/\*+\/\s*$/, '')
    .split('\n')
    .map((l) => l.replace(/^\s*(\/\/+|#+|\*)?/, '').trim())
    .filter(Boolean);
  if (!lines.length) return false;
  const codeLike = lines.filter((l) => /[;{}(),]$/.test(l) || /^(const|let|var|return|if|for|import|def|fn|func)\b/.test(l));
  return codeLike.length * 2 >= lines.length;
}

/**
 * Whether a comment counts as documentation: explicit doc syntax, or a comment block
 * attached (no blank line) to the declaration that follows it, as in Go, Ruby or Python.
 * Attached comments only count outside function bodies (`functionTypes` are the node types
 * that own implementation bodies) and when they do not look like commented-out code.
 */
export function isDocComment(node: Node, source: string, functionTypes: ReadonlySet<string>): boolean {
  const text = node.text;
  if (DOC_SYNTAX.test(text)) return true;
  if (!startsLine(node, source)) return false; // trailing comment after code
  for (let p = node.parent; p; p = p.parent) {
    if (functionTypes.has(p.type)) return false;
  }
  if (looksLikeCode(text)) return false;
  let next = node.nextNamedSibling;
  let row = node.endPosition.row;
  while (next && COMMENT_TYPE.test(next.type)) {
    if (next.startPosition.row > row + 1) return false;
    row = next.endPosition.row;
    next = next.nextNamedSibling;
  }
  if (!next) return false;
  // Some grammars end line comments with the newline, putting the next node on `row + 1`.
  const gap = next.startPosition.row - row;
  return gap === 1 || (gap === 0 && text.endsWith('\n'));
}

function startsLine(node: Node, source: string): boolean {
  const lineStart = source.lastIndexOf('\n', node.startIndex - 1) + 1;
  return source.slice(lineStart, node.startIndex).trim() === '';
}

/**
 * The span to delete for a comment: whole lines when the comment is alone on them
 * (including the newline), otherwise the comment and the whitespace before it.
 */
export function removalSpan(source: string, start: number, end: number): { start: number; end: number } {
  if (source[end - 1] === '\n') end--; // line comments that include their newline
  const lineStart = source.lastIndexOf('\n', start - 1) + 1;
  const before = source.slice(lineStart, start);
  let lineEnd = source.indexOf('\n', end);
  if (lineEnd === -1) lineEnd = source.length;
  const after = source.slice(end, lineEnd);
  if (before.trim() === '' && after.trim() === '') {
    return { start: lineStart, end: Math.min(lineEnd + 1, source.length) };
  }
  if (before.trim() === '') {
    // `/* note */ code();` — drop the comment and the spaces after it.
    let e = end;
    while (source[e] === ' ' || source[e] === '\t') e++;
    return { start, end: e };
  }
  let s = start;
  while (s > lineStart && (source[s - 1] === ' ' || source[s - 1] === '\t')) s--;
  return { start: s, end };
}
