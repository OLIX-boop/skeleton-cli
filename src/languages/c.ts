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

/** Whether a declarator (possibly wrapped in pointers/references) declares a function. */
function declaresFunction(declarator: Node | null): boolean {
  for (let d = declarator; d; d = d.childForFieldName('declarator')) {
    if (d.type === 'function_declarator') return true;
  }
  return false;
}

const TYPE_SPECIFIERS = new Set(['struct_specifier', 'enum_specifier', 'union_specifier']);

const cOutline: NonNullable<LanguageSpec['outline']> = {
  containers: ['namespace_definition', 'class_specifier', 'linkage_specification'],
  declarations: ['preproc_function_def'],
  label(node, _depth, source) {
    // Only type *definitions* (with a body), not references like `struct point *p`.
    if (TYPE_SPECIFIERS.has(node.type)) {
      const body = node.childForFieldName('body');
      return body ? source.slice(node.startIndex, body.startIndex) : '';
    }
    // `typedef struct { ... } point_t;` -> `typedef struct point_t`.
    if (node.type === 'type_definition') {
      const type = node.childForFieldName('type');
      const name = node.childForFieldName('declarator')?.text ?? '';
      const body = type?.childForFieldName('body');
      return body ? `typedef ${source.slice(type!.startIndex, body.startIndex)} ${name}` : node.text.replace(/;\s*$/, '');
    }
    // Prototypes and in-class method declarations: `int add(int a, int b);`.
    if ((node.type === 'declaration' || node.type === 'field_declaration') && declaresFunction(node.childForFieldName('declarator'))) {
      return node.text;
    }
    return undefined;
  },
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
