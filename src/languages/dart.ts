import type { Node } from 'web-tree-sitter';
import { braceBlock, isMultiline } from './common.js';
import type { BodyReplacement, LanguageSpec } from './types.js';

/**
 * Dart: function and method bodies (block or multi-line `=>` bodies) are replaced.
 * Classes, mixins, extensions, fields, constructors' signatures and one-line arrow
 * bodies are kept.
 */
function bodyReplacement(node: Node, placeholder: string): BodyReplacement | null {
  if (node.type !== 'function_body') return null;
  const block = node.namedChildren.find((c) => c?.type === 'block');
  if (block) return { node: block, text: braceBlock(placeholder) };
  if (isMultiline(node)) return { node, text: braceBlock(placeholder) };
  return null;
}

export const dart: LanguageSpec = {
  id: 'dart',
  fence: 'dart',
  grammar: 'tree-sitter-dart',
  extensions: ['.dart'],
  bodyReplacement,
};
