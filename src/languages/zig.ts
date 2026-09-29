import type { Node } from 'web-tree-sitter';
import type { BodyReplacement, LanguageSpec } from './types.js';

/**
 * Zig has only line comments, so a stripped body becomes a block holding one:
 * `{\n    // ...\n}`, indented like the declaration.
 */
function lineCommentBlock(owner: Node, placeholder: string): string {
  const indent = ' '.repeat(owner.startPosition.column);
  return `{\n${indent}    // ${placeholder.replace(/\n/g, ' ')}\n${indent}}`;
}

const CONTAINER_TYPES = new Set(['struct_declaration', 'enum_declaration', 'union_declaration', 'opaque_declaration']);

/** `fn List(comptime T: type) type { return struct { … }; }`: the returned type is the API. */
function returnsType(node: Node): boolean {
  return node.childForFieldName('type')?.text === 'type';
}

/**
 * Zig: function bodies, `test` blocks and top-level `comptime` blocks are replaced.
 * Functions returning `type` (generics) keep their body so the returned struct's fields and
 * method signatures stay visible. Containers, fields, constants and doc comments are kept.
 */
function bodyReplacement(node: Node, placeholder: string): BodyReplacement | null {
  if (node.type === 'function_declaration') {
    if (returnsType(node)) return null;
    const body = node.childForFieldName('body');
    return body ? { node: body, text: lineCommentBlock(node, placeholder) } : null;
  }
  if (node.type === 'test_declaration' || node.type === 'comptime_declaration') {
    const body = node.namedChildren.find((c) => c?.type === 'block');
    return body ? { node: body, text: lineCommentBlock(node, placeholder) } : null;
  }
  return null;
}

function containerType(node: Node): Node | undefined {
  if (node.type !== 'variable_declaration') return undefined;
  return node.namedChildren.find((c) => !!c && CONTAINER_TYPES.has(c.type)) ?? undefined;
}

/** `const Point = struct { … };` spanning lines → the struct node holding the members. */
function containerOf(node: Node): Node | undefined {
  const type = containerType(node);
  return type && type.startPosition.row !== type.endPosition.row ? type : undefined;
}

export const zig: LanguageSpec = {
  id: 'zig',
  fence: 'zig',
  grammar: 'tree-sitter-zig',
  extensions: ['.zig'],
  bodyReplacement,
  candidates: ['function_declaration', 'test_declaration', 'comptime_declaration'],
  outline: {
    isContainer: (node) => !!containerOf(node),
    body: containerOf,
    members: ['container_field'],
    // One-line containers (`const E = enum { a, b };`) are listed whole.
    label: (node) => (containerType(node) && !containerOf(node) ? node.text.replace(/;\s*$/, '') : undefined),
  },
};
