import type { Node } from 'web-tree-sitter';
import { braceBlock, innerBraces } from './common.js';
import type { BodyReplacement, LanguageSpec } from './types.js';

const WITH_BODY = new Set(['function_declaration', 'init_declaration', 'deinit_declaration', 'subscript_declaration']);

/**
 * Swift: function, initializer, deinitializer, subscript and computed-property bodies are
 * replaced. Types, protocols, extensions, stored properties and attributes are kept.
 */
function bodyReplacement(node: Node, placeholder: string): BodyReplacement | null {
  if (WITH_BODY.has(node.type)) {
    const body = node.childForFieldName('body') ?? node.namedChildren.find((c) => c?.type === 'function_body') ?? null;
    return body ? { node: body, text: braceBlock(placeholder) } : null;
  }
  if (node.type === 'computed_property') return innerBraces(node, placeholder);
  return null;
}

export const swift: LanguageSpec = {
  id: 'swift',
  fence: 'swift',
  grammar: 'tree-sitter-swift',
  extensions: ['.swift'],
  bodyReplacement,
  candidates: [...WITH_BODY, 'computed_property'],
};
