import type { Node } from 'web-tree-sitter';
import { braceBlock } from './common.js';
import type { BodyReplacement, LanguageSpec } from './types.js';

const FUNCTION_LIKE = new Set(['function_declaration', 'method_declaration', 'func_literal']);

/**
 * Go skeleton rules: function, method and function-literal bodies are replaced with
 * `{ /* ... *\/ }`. Package clauses, imports, types, structs, interfaces, constants and
 * variables are kept.
 */
function bodyReplacement(node: Node, placeholder: string): BodyReplacement | null {
  if (!FUNCTION_LIKE.has(node.type)) return null;
  const body = node.childForFieldName('body');
  if (!body) return null; // e.g. assembly-backed declarations
  return { node: body, text: braceBlock(placeholder) };
}

export const go: LanguageSpec = {
  id: 'go',
  fence: 'go',
  grammar: 'tree-sitter-go',
  extensions: ['.go'],
  bodyReplacement,
  candidates: ['function_declaration', 'method_declaration', 'func_literal'],
};
