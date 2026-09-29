import type { Node } from 'web-tree-sitter';
import type { BodyReplacement, LanguageSpec } from './types.js';

/**
 * Julia: the statements of `function … end` and `macro … end` definitions become a
 * `#= ... =#` block comment. Modules, structs, abstract and primitive types, one-line
 * method definitions (`area(r) = π * r^2`), docstrings, `using` and `export` are kept.
 */
function bodyReplacement(node: Node, placeholder: string): BodyReplacement | null {
  if (node.type !== 'function_definition' && node.type !== 'macro_definition') return null;
  const signature = node.namedChildren.find((c) => c?.type === 'signature');
  const end = node.lastChild;
  if (!signature || end?.type !== 'end' || node.namedChildren.at(-1)?.id === signature.id) return null;
  return { node, start: signature.endIndex, end: end.startIndex, text: ` #= ${placeholder.replace(/=#/g, '= #')} =# ` };
}

export const julia: LanguageSpec = {
  id: 'julia',
  fence: 'julia',
  grammar: 'tree-sitter-julia',
  extensions: ['.jl'],
  bodyReplacement,
  candidates: ['function_definition', 'macro_definition'],
  outline: {
    containers: ['module_definition'],
    body: (node) => (node.type === 'module_definition' ? node : undefined),
    declarations: ['struct_definition', 'abstract_definition', 'primitive_definition', 'const_statement'],
  },
};
