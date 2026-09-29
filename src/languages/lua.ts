import type { Node } from 'web-tree-sitter';
import type { BodyReplacement, LanguageSpec } from './types.js';

/**
 * Lua: bodies of `function` declarations (local, module `M.f` and method `M:f` forms) and
 * anonymous functions become a `--[[ ... ]]` block comment, which stays valid even on
 * one-line functions. Tables, locals, `require`s and module returns are kept.
 */
function bodyReplacement(node: Node, placeholder: string): BodyReplacement | null {
  if (node.type !== 'function_declaration' && node.type !== 'function_definition') return null;
  const body = node.childForFieldName('body');
  if (!body || body.namedChildCount === 0) return null;
  return { node: body, text: `--[[ ${placeholder.replace(/]]/g, '] ]')} ]]` };
}

export const lua: LanguageSpec = {
  id: 'lua',
  fence: 'lua',
  grammar: 'tree-sitter-lua',
  extensions: ['.lua'],
  bodyReplacement,
  candidates: ['function_declaration', 'function_definition'],
};
