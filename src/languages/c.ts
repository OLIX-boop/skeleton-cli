import type { Node } from 'web-tree-sitter';
import { braceBlock } from './common.js';
import type { BodyReplacement, LanguageSpec } from './types.js';

/**
 * C and C++: function definitions (free functions, inline and out-of-line methods,
 * constructors, templates) and C++ lambdas lose their bodies. Structs, classes, unions,
 * enums, typedefs, prototypes, macros and member-initializer lists are kept.
 */
function bodyReplacement(node: Node, placeholder: string): BodyReplacement | null {
  if (node.type === 'function_definition' || node.type === 'lambda_expression') {
    const body = node.childForFieldName('body');
    if (body?.type === 'compound_statement') return { node: body, text: braceBlock(placeholder) };
  }
  return null;
}

const cOutline = {
  containers: ['namespace_definition', 'class_specifier', 'linkage_specification'],
  declarations: ['struct_specifier', 'enum_specifier', 'union_specifier', 'type_definition', 'preproc_function_def'],
};

export const c: LanguageSpec = {
  id: 'c',
  fence: 'c',
  grammar: 'tree-sitter-c',
  extensions: ['.c', '.h'],
  bodyReplacement,
  outline: cOutline,
  candidates: ['function_definition', 'lambda_expression'],
};

export const cpp: LanguageSpec = {
  id: 'cpp',
  fence: 'cpp',
  grammar: 'tree-sitter-cpp',
  extensions: ['.cpp', '.cc', '.cxx', '.c++', '.hpp', '.hh', '.hxx', '.h++', '.ipp', '.tpp', '.inl'],
  bodyReplacement,
  outline: cOutline,
  candidates: ['function_definition', 'lambda_expression'],
};
