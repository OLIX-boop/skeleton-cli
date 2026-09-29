import type { Node } from 'web-tree-sitter';
import type { BodyReplacement, LanguageSpec } from './types.js';

/**
 * Ruby: `def` and `def self.` bodies are replaced with a `# ...` comment (or a `"..."`
 * string when the method fits on one line, so `end` stays live). Classes, modules,
 * `attr_*`/`include`/DSL calls, constants and blocks (e.g. routes, RSpec) are kept.
 * Endless methods (`def x = expr`) are already signature-sized and kept. In specs,
 * `describe`/`context` structure is kept while `it`/`before`/... block bodies are stripped.
 */
/** RSpec/Minitest-spec calls whose blocks are test implementations. */
const TEST_CALLS = new Set(['it', 'specify', 'example', 'scenario', 'its', 'test', 'before', 'after', 'around', 'setup', 'teardown']);

function replaceBody(owner: Node, body: Node | null, placeholder: string): BodyReplacement | null {
  if (!body) return null;
  const ownLines = body.startPosition.row > owner.startPosition.row && body.endPosition.row < owner.endPosition.row;
  return { node: body, text: ownLines ? `# ${placeholder}` : JSON.stringify(placeholder) };
}

function bodyReplacement(node: Node, placeholder: string): BodyReplacement | null {
  if (node.type === 'method' || node.type === 'singleton_method') {
    const body = node.childForFieldName('body');
    return body?.type === 'body_statement' ? replaceBody(node, body, placeholder) : null;
  }
  if (node.type === 'call') {
    const method = node.childForFieldName('method');
    const block = node.childForFieldName('block');
    if (!method || !block || !TEST_CALLS.has(method.text) || node.childForFieldName('receiver')) return null;
    return replaceBody(block, block.childForFieldName('body'), placeholder);
  }
  return null;
}

export const ruby: LanguageSpec = {
  id: 'ruby',
  fence: 'ruby',
  grammar: 'tree-sitter-ruby',
  extensions: ['.rb', '.rake', '.gemspec', '.ru'],
  bodyReplacement,
  candidates: ['method', 'singleton_method', 'call'],
};
