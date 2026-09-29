import type { Node } from 'web-tree-sitter';
import { isMultiline } from './common.js';
import type { BodyReplacement, LanguageSpec } from './types.js';

function placeholderExpr(placeholder: string): string {
  return `assert false (* ${placeholder.replace(/\*\)/g, '* )')} *)`;
}

/**
 * OCaml: multi-line bodies of functions (`let f x = …`, `let f = fun x -> …`,
 * `let rec f = function …`), of `let () = …` entry points and of object methods become
 * `assert false (* ... *)`. Types, modules, signatures, exceptions, `external`s, one-line
 * definitions and plain values are kept.
 */
function bodyReplacement(node: Node, placeholder: string): BodyReplacement | null {
  if (node.type !== 'let_binding' && node.type !== 'method_definition') return null;
  const body = node.childForFieldName('body');
  if (!body || !isMultiline(body)) return null;
  const hasParameters = node.namedChildren.some((c) => c?.type === 'parameter');
  const entryPoint = node.childForFieldName('pattern')?.type === 'unit';
  if (body.type === 'fun_expression') {
    const inner = body.childForFieldName('body');
    return inner ? { node: inner, text: placeholderExpr(placeholder) } : null;
  }
  if (hasParameters || entryPoint || body.type === 'function_expression' || node.type === 'method_definition') {
    return { node: body, text: placeholderExpr(placeholder) };
  }
  return null;
}

const outline: NonNullable<LanguageSpec['outline']> = {
  containers: ['module_binding', 'module_type_definition', 'class_binding'],
  declarations: ['type_definition', 'exception_definition', 'external', 'value_specification', 'module_type_definition'],
  members: ['instance_variable_definition'],
};

export const ocaml: LanguageSpec = {
  id: 'ocaml',
  fence: 'ocaml',
  grammar: 'tree-sitter-ocaml',
  extensions: ['.ml'],
  bodyReplacement,
  candidates: ['let_binding', 'method_definition'],
  outline,
};

/** OCaml interfaces (`.mli`) have no bodies: they are kept whole, and outlined. */
export const ocamlInterface: LanguageSpec = {
  id: 'ocaml_interface',
  fence: 'ocaml',
  grammar: 'tree-sitter-ocaml_interface',
  extensions: ['.mli'],
  bodyReplacement: () => null,
  candidates: [],
  outline,
};
