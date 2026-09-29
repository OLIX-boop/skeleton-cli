import type { Node } from 'web-tree-sitter';
import { braceBlock, isMultiline } from './common.js';
import type { BodyReplacement, LanguageSpec } from './types.js';

const WITH_BODY = new Set(['method_declaration', 'constructor_declaration', 'compact_constructor_declaration']);

/**
 * Java: method, constructor (incl. record compact constructors), lambda, static and
 * instance initializer bodies are replaced. Fields, annotations, interfaces, enums,
 * records and abstract/interface method signatures are kept.
 */
function bodyReplacement(node: Node, placeholder: string): BodyReplacement | null {
  if (WITH_BODY.has(node.type)) {
    const body = node.childForFieldName('body');
    return body ? { node: body, text: braceBlock(placeholder) } : null;
  }
  if (node.type === 'lambda_expression') {
    const body = node.childForFieldName('body');
    if (body && (body.type === 'block' || isMultiline(body))) return { node: body, text: braceBlock(placeholder) };
    return null;
  }
  if (node.type === 'static_initializer') {
    const block = node.namedChildren.find((c) => c?.type === 'block');
    return block ? { node: block, text: braceBlock(placeholder) } : null;
  }
  // Instance initializer: a bare block directly inside a class body.
  if (node.type === 'block' && node.parent?.type === 'class_body') {
    return { node, text: braceBlock(placeholder) };
  }
  return null;
}

export const java: LanguageSpec = {
  id: 'java',
  fence: 'java',
  grammar: 'tree-sitter-java',
  extensions: ['.java'],
  bodyReplacement,
};
