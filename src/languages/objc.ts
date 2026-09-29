import type { Node } from 'web-tree-sitter';
import { braceBlock } from './common.js';
import type { BodyReplacement, LanguageSpec } from './types.js';

/**
 * Objective-C: method implementations, C functions and multi-line blocks (`^{ … }`) lose
 * their bodies. `@interface`/`@protocol` declarations, properties, method declarations,
 * imports and macros are kept.
 */
function bodyReplacement(node: Node, placeholder: string): BodyReplacement | null {
  if (node.type === 'function_definition') {
    const body = node.childForFieldName('body');
    return body?.type === 'compound_statement' ? { node: body, text: braceBlock(placeholder) } : null;
  }
  if (node.type === 'method_definition' || node.type === 'block_literal') {
    const body = [...node.namedChildren].reverse().find((c) => c?.type === 'compound_statement');
    if (!body || (node.type === 'block_literal' && body.startPosition.row === body.endPosition.row)) return null;
    return { node: body, text: braceBlock(placeholder) };
  }
  return null;
}

const CONTAINERS = new Set(['class_interface', 'class_implementation', 'protocol_declaration', 'category_interface', 'category_implementation']);

export const objc: LanguageSpec = {
  id: 'objc',
  fence: 'objectivec',
  grammar: 'tree-sitter-objc',
  extensions: ['.m', '.mm'],
  bodyReplacement,
  candidates: ['function_definition', 'method_definition', 'block_literal'],
  outline: {
    containers: [...CONTAINERS],
    // Members sit directly in the container (or in `implementation_definition` wrappers).
    body: (node) => (CONTAINERS.has(node.type) ? node : undefined),
    members: ['method_declaration', 'property_declaration'],
  },
};
