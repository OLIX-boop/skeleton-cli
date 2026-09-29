import type { Node } from 'web-tree-sitter';
import type { BodyReplacement, LanguageSpec } from './types.js';

/**
 * Bash: function bodies become `{ : '...'; }` (the no-op builtin, so the script stays
 * valid). Top-level commands, variables and sourcing are kept.
 */
function bodyReplacement(node: Node, placeholder: string): BodyReplacement | null {
  if (node.type !== 'function_definition') return null;
  const body = node.childForFieldName('body');
  if (body?.type !== 'compound_statement') return null;
  return { node: body, text: `{ : '${placeholder.replace(/'/g, '')}'; }` };
}

export const bash: LanguageSpec = {
  id: 'bash',
  fence: 'bash',
  grammar: 'tree-sitter-bash',
  extensions: ['.sh', '.bash'],
  bodyReplacement,
};
