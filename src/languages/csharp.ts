import type { Node } from 'web-tree-sitter';
import { braceBlock, isMultiline } from './common.js';
import type { BodyReplacement, LanguageSpec } from './types.js';

const MEMBERS = new Set([
  'method_declaration',
  'constructor_declaration',
  'destructor_declaration',
  'operator_declaration',
  'conversion_operator_declaration',
  'local_function_statement',
  'accessor_declaration',
]);

function arrowPlaceholder(placeholder: string): string {
  return `=> default /* ${placeholder} */`;
}

/**
 * C#: bodies of methods, constructors, finalizers, operators, local functions, property
 * accessors, lambdas and anonymous methods are replaced. Multi-line expression-bodied
 * members (`=> ...`) become `=> default /* ... *\/`. Declarations, attributes, properties'
 * shapes, interfaces, records and enums are kept.
 */
function bodyReplacement(node: Node, placeholder: string): BodyReplacement | null {
  if (MEMBERS.has(node.type) || node.type === 'property_declaration' || node.type === 'indexer_declaration') {
    const body = node.childForFieldName('body') ?? node.childForFieldName('value');
    if (!body) return null;
    if (body.type === 'block') return { node: body, text: braceBlock(placeholder) };
    if (body.type === 'arrow_expression_clause' && isMultiline(body)) {
      return { node: body, text: arrowPlaceholder(placeholder) };
    }
    return null;
  }
  if (node.type === 'lambda_expression' || node.type === 'anonymous_method_expression') {
    const body = node.childForFieldName('body') ?? node.namedChildren.find((c) => c?.type === 'block') ?? null;
    if (body && (body.type === 'block' || isMultiline(body))) return { node: body, text: braceBlock(placeholder) };
  }
  return null;
}

export const csharp: LanguageSpec = {
  id: 'csharp',
  fence: 'csharp',
  grammar: 'tree-sitter-c_sharp',
  extensions: ['.cs'],
  bodyReplacement,
  candidates: [...MEMBERS, 'property_declaration', 'indexer_declaration', 'lambda_expression', 'anonymous_method_expression'],
  outline: {
    containers: ['class_declaration', 'struct_declaration', 'interface_declaration', 'record_declaration', 'namespace_declaration'],
    declarations: ['enum_declaration', 'delegate_declaration', 'method_declaration', 'property_declaration', 'event_declaration'],
  },
};
