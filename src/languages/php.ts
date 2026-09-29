import type { Node } from 'web-tree-sitter';
import { braceBlock } from './common.js';
import type { BodyReplacement, LanguageSpec } from './types.js';

const WITH_BODY = new Set(['method_declaration', 'function_definition', 'anonymous_function_creation_expression', 'anonymous_function']);

/**
 * PHP: function, method and closure bodies are replaced. Namespaces, `use` statements,
 * classes, interfaces, traits, properties, constants, attributes and abstract/interface
 * signatures are kept. Arrow functions (`fn($x) => ...`) are single expressions and kept.
 */
function bodyReplacement(node: Node, placeholder: string): BodyReplacement | null {
  if (!WITH_BODY.has(node.type)) return null;
  const body = node.childForFieldName('body');
  return body?.type === 'compound_statement' ? { node: body, text: braceBlock(placeholder) } : null;
}

export const php: LanguageSpec = {
  id: 'php',
  fence: 'php',
  grammar: 'tree-sitter-php',
  extensions: ['.php'],
  bodyReplacement,
  candidates: [...WITH_BODY],
};
