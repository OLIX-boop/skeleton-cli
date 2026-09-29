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
 * - Callbacks passed to `describe`/`context`/`suite` are kept so the names of the tests
 *   inside survive; each `it`/`test` callback body is stripped.
 * - Everything else (imports, exports, types, interfaces, enums, decorators, class
 *   fields, overload signatures, comments outside bodies) is left untouched.
 */
/** Test-suite containers whose callbacks hold structure (test names), not implementation. */
const SUITE_CALLEE = /^[fx]?(describe|context|suite)\b/;

/** Whether `node` is the callback of `describe(...)`/`context(...)`/`suite(...)`. */
function isSuiteCallback(node: Node): boolean {
  const args = node.parent;
  if (args?.type !== 'arguments') return false;
  const call = args.parent;
  if (call?.type !== 'call_expression') return false;
  const callee = call.childForFieldName('function');
  return !!callee && SUITE_CALLEE.test(callee.text);
}

function bodyReplacement(node: Node, placeholder: string): BodyReplacement | null {
  if (FUNCTION_LIKE.has(node.type)) {
    // Keep test suites' structure so test names survive; the tests' own bodies are stripped.
    if (isSuiteCallback(node)) return null;
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

const shared = {
  bodyReplacement,
  candidates: [...FUNCTION_LIKE, 'class_static_block'],
  outline: {
    containers: ['class_declaration', 'abstract_class_declaration', 'class', 'interface_declaration', 'internal_module', 'module'],
    declarations: ['type_alias_declaration', 'enum_declaration', 'function_signature'],
    members: ['method_signature', 'abstract_method_signature', 'property_signature', 'public_field_definition'],
  },
} satisfies Pick<LanguageSpec, 'bodyReplacement' | 'candidates' | 'outline'>;

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
