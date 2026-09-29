import type { Node } from 'web-tree-sitter';
import { braceBlock as block } from './common.js';
import type { BodyReplacement, LanguageSpec } from './types.js';

/** Nodes whose `body` field holds an implementation (functions, methods, closures). */
const FUNCTION_LIKE = new Set([
  'function_declaration',
  'generator_function_declaration',
  'function_expression',
  'function', // older grammar name for function expressions
  'generator_function',
  'arrow_function',
  'method_definition',
]);

/**
 * TypeScript / JavaScript skeleton rules.
 *
 * - Function, method, constructor, accessor and closure bodies (`{ ... }`) are replaced.
 * - Arrow functions with an expression body are replaced only when the expression spans
 *   multiple lines; one-liners are already signature-sized and often carry meaning
 *   (e.g. `const isAdmin = (u: User) => u.role === 'admin'`).
 * - `static { ... }` class blocks are replaced.
 * - Everything else (imports, exports, types, interfaces, enums, decorators, class
 *   fields, overload signatures, comments outside bodies) is left untouched.
 */
function bodyReplacement(node: Node, placeholder: string): BodyReplacement | null {
  if (FUNCTION_LIKE.has(node.type)) {
    const body = node.childForFieldName('body');
    if (!body) return null; // overloads, abstract/ambient signatures
    if (body.type === 'statement_block') {
      return { node: body, text: block(placeholder) };
    }
    // Expression-bodied arrow function: replace from just after `=>` so the
    // placeholder stays on the signature line.
    if (body.startPosition.row !== body.endPosition.row) {
      const arrow = body.previousSibling;
      return arrow
        ? { node: body, start: arrow.endIndex, text: ` ${block(placeholder)}` }
        : { node: body, text: block(placeholder) };
    }
    return null;
  }
  if (node.type === 'class_static_block') {
    const body = node.childForFieldName('body') ?? node.namedChildren.find((c) => c?.type === 'statement_block');
    if (body) return { node: body, text: block(placeholder) };
  }
  return null;
}

const shared = { bodyReplacement } satisfies Pick<LanguageSpec, 'bodyReplacement'>;

export const typescript: LanguageSpec = {
  ...shared,
  id: 'typescript',
  fence: 'ts',
  grammar: 'tree-sitter-typescript',
  extensions: ['.ts', '.mts', '.cts'],
};

export const tsx: LanguageSpec = {
  ...shared,
  id: 'tsx',
  fence: 'tsx',
  grammar: 'tree-sitter-tsx',
  extensions: ['.tsx'],
};

export const javascript: LanguageSpec = {
  ...shared,
  id: 'javascript',
  fence: 'js',
  // The JavaScript grammar handles JSX natively.
  grammar: 'tree-sitter-javascript',
  extensions: ['.js', '.mjs', '.cjs', '.jsx'],
};
