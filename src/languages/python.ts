import type { Node } from 'web-tree-sitter';
import type { BodyReplacement, LanguageSpec, RuleContext } from './types.js';

function isDocstring(node: Node | null | undefined): node is Node {
  return node?.type === 'expression_statement' && node.namedChildCount === 1 && node.namedChild(0)?.type === 'string';
}

/** A body consisting solely of `...` or `pass` has nothing left to strip. */
function isTrivial(node: Node | null | undefined): boolean {
  if (!node) return true;
  if (node.type === 'pass_statement') return true;
  return node.type === 'expression_statement' && node.namedChildCount === 1 && node.namedChild(0)?.type === 'ellipsis';
}

function marker(placeholder: string): string {
  return placeholder === '...' ? '...' : `...  # ${placeholder}`;
}

/**
 * Python skeleton rules.
 *
 * - `def` / `async def` bodies (functions and methods, decorated or not) are replaced
 *   with `...`, keeping the docstring when there is one.
 * - Class bodies are kept (fields, nested classes, method signatures), lambdas are kept
 *   (they are single expressions).
 */
function bodyReplacement(node: Node, placeholder: string, context?: RuleContext): BodyReplacement | null {
  if (node.type !== 'function_definition') return null;
  const body = node.childForFieldName('body');
  if (!body || body.namedChildCount === 0) return null;

  const statements = body.namedChildren.filter((c): c is Node => c !== null && c.type !== 'comment');
  const first = statements[0];
  const hasDocstring = isDocstring(first);
  const docstring = hasDocstring && context?.comments !== 'none' ? first : undefined;
  const rest = hasDocstring ? statements.slice(1) : statements;
  if (rest.length === 0 || (rest.length === 1 && isTrivial(rest[0]))) {
    // Nothing to strip, unless the docstring itself should go.
    if (!(hasDocstring && context?.comments === 'none')) return null;
  }

  // Single-line bodies (`def f(): return 1`) collapse to `def f(): ...`.
  const text = marker(placeholder);
  if (!docstring) return { node: body, text };

  const indent = ' '.repeat(body.startPosition.column);
  const docText = docstring.text;
  if (body.startPosition.row === node.startPosition.row) {
    return { node: body, text: `${docText}; ${text}` };
  }
  return { node: body, text: `${docText}\n${indent}${text}` };
}

/**
 * Docstrings of modules and classes (function docstrings are handled with the body).
 * Removing a class docstring that is the class's only statement would leave an empty
 * block, so it becomes `...` instead.
 */
function docReplacement(node: Node): string | undefined {
  if (!isDocstring(node)) return undefined;
  const parent = node.parent;
  if (!parent) return undefined;
  const firstStatement = parent.namedChildren.find((c) => c !== null && c.type !== 'comment');
  if (firstStatement?.id !== node.id) return undefined;
  if (parent.type === 'module') return '';
  if (parent.type === 'block' && parent.parent?.type === 'class_definition') {
    return parent.namedChildren.filter((c) => c !== null && c.type !== 'comment').length > 1 ? '' : '...';
  }
  if (parent.type === 'block' && parent.parent?.type === 'function_definition') {
    return parent.namedChildren.filter((c) => c !== null && c.type !== 'comment').length > 1 ? '' : '...';
  }
  return undefined;
}

export const python: LanguageSpec = {
  id: 'python',
  fence: 'python',
  grammar: 'tree-sitter-python',
  extensions: ['.py', '.pyi', '.pyw'],
  bodyReplacement,
  candidates: ['function_definition'],
  outline: { containers: ['class_definition'] },
  docReplacement,
  docCandidates: ['expression_statement'],
};
