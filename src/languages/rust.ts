import type { Node } from 'web-tree-sitter';
import { braceBlock } from './common.js';
import type { BodyReplacement, LanguageSpec } from './types.js';

/**
 * Rust skeleton rules: bodies of free functions, inherent/trait impl methods, trait
 * default methods and block-bodied closures are replaced with `{ /* ... *\/ }`.
 * Structs, enums, traits, impl headers, type aliases, `use` items, macros and
 * attributes are kept.
 */
function bodyReplacement(node: Node, placeholder: string): BodyReplacement | null {
  if (node.type === 'function_item') {
    const body = node.childForFieldName('body');
    return body ? { node: body, text: braceBlock(placeholder) } : null;
  }
  if (node.type === 'closure_expression') {
    const body = node.childForFieldName('body');
    if (body?.type === 'block') return { node: body, text: braceBlock(placeholder) };
  }
  return null;
}

export const rust: LanguageSpec = {
  id: 'rust',
  fence: 'rust',
  grammar: 'tree-sitter-rust',
  extensions: ['.rs'],
  bodyReplacement,
  candidates: ['function_item', 'closure_expression'],
  outline: {
    containers: ['impl_item', 'trait_item', 'mod_item'],
    declarations: ['struct_item', 'enum_item', 'type_item', 'union_item', 'macro_definition', 'const_item', 'static_item'],
    members: ['function_signature_item'],
  },
};
