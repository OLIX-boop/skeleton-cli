import type { Node } from 'web-tree-sitter';
import { braceBlock, isMultiline } from './common.js';
import type { BodyReplacement, LanguageSpec } from './types.js';

/**
 * Scala: `def` bodies that are blocks or span several lines become `{ /* ... *\/ }`.
 * (`???` would be more idiomatic, but the bundled grammar cannot parse it, which would
 * break re-processing.) One-line expression bodies, classes, traits, objects, case
 * classes, vals and abstract `def`s are kept.
 */
function bodyReplacement(node: Node, placeholder: string): BodyReplacement | null {
  if (node.type !== 'function_definition') return null;
  const body = node.childForFieldName('body');
  if (!body || (body.type !== 'block' && !isMultiline(body))) return null;
  return { node: body, text: braceBlock(placeholder) };
}

export const scala: LanguageSpec = {
  id: 'scala',
  fence: 'scala',
  grammar: 'tree-sitter-scala',
  extensions: ['.scala', '.sc'],
  bodyReplacement,
  candidates: ['function_definition'],
  outline: { containers: ['class_definition', 'object_definition', 'trait_definition'], declarations: ['function_declaration'] },
};
