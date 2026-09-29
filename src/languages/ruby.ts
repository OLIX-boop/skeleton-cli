import type { Node } from 'web-tree-sitter';
import type { BodyReplacement, LanguageSpec } from './types.js';

/**
 * Ruby: `def` and `def self.` bodies are replaced with a `# ...` comment (or a `"..."`
 * string when the method fits on one line, so `end` stays live). Classes, modules,
 * `attr_*`/`include`/DSL calls, constants and blocks (e.g. routes, RSpec) are kept.
 * Endless methods (`def x = expr`) are already signature-sized and kept.
 */
function bodyReplacement(node: Node, placeholder: string): BodyReplacement | null {
  if (node.type !== 'method' && node.type !== 'singleton_method') return null;
  const body = node.childForFieldName('body');
  if (!body || body.type !== 'body_statement') return null;
  const ownLines = body.startPosition.row > node.startPosition.row && body.endPosition.row < node.endPosition.row;
  return { node: body, text: ownLines ? `# ${placeholder}` : JSON.stringify(placeholder) };
}

export const ruby: LanguageSpec = {
  id: 'ruby',
  fence: 'ruby',
  grammar: 'tree-sitter-ruby',
  extensions: ['.rb', '.rake', '.gemspec', '.ru'],
  bodyReplacement,
  candidates: ['method', 'singleton_method'],
};
