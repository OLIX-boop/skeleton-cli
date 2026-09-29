import type { Node } from 'web-tree-sitter';
import { braceBlock, innerBraces, isMultiline } from './common.js';
import type { BodyReplacement, LanguageSpec } from './types.js';

function functionBody(node: Node): Node | undefined {
  return node.namedChildren.find((c): c is Node => c?.type === 'function_body');
}

/**
 * Kotlin: function, getter/setter, `init` and secondary-constructor bodies are replaced.
 * Multi-line expression bodies (`= ...`) become `= TODO()`, which type-checks everywhere.
 * Classes, data classes, objects, interfaces, properties and lambdas (Gradle/Ktor DSLs)
 * are kept.
 */
function bodyReplacement(node: Node, placeholder: string): BodyReplacement | null {
  if (node.type === 'function_declaration' || node.type === 'getter' || node.type === 'setter') {
    const body = functionBody(node);
    if (!body) return null;
    if (body.text.startsWith('{')) return { node: body, text: braceBlock(placeholder) };
    if (isMultiline(body)) return { node: body, text: `= TODO() /* ${placeholder} */` };
    return null;
  }
  if (node.type === 'anonymous_initializer' || node.type === 'secondary_constructor') {
    // Newer grammars wrap the body in a `block`; older ones put the braces on the node itself.
    const block = node.namedChildren.find((c) => c?.type === 'block');
    return block ? { node: block, text: braceBlock(placeholder) } : innerBraces(node, placeholder);
  }
  return null;
}

export const kotlin: LanguageSpec = {
  id: 'kotlin',
  fence: 'kotlin',
  grammar: 'tree-sitter-kotlin',
  extensions: ['.kt', '.kts'],
  bodyReplacement,
  candidates: ['function_declaration', 'getter', 'setter', 'anonymous_initializer', 'secondary_constructor'],
  outline: { containers: ['class_declaration', 'object_declaration', 'companion_object'], members: ['function_declaration'] },
};
