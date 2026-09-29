import type { Node } from 'web-tree-sitter';
import type { BodyReplacement, LanguageSpec } from './types.js';

const DEFINITIONS = new Set([
  'def',
  'defp',
  'defmacro',
  'defmacrop',
  'defguard',
  'defguardp',
  // ExUnit: test implementations (describe blocks keep their structure).
  'test',
  'setup',
  'setup_all',
  'property',
]);

/**
 * Elixir: `def`/`defp`/`defmacro` `do ... end` bodies are replaced with a `# ...` comment.
 * Modules, `@doc`/`@spec` attributes, `use`/`import`/`alias`, structs and one-line
 * `do:` definitions are kept.
 */
function bodyReplacement(node: Node, placeholder: string): BodyReplacement | null {
  if (node.type !== 'call') return null;
  const target = node.childForFieldName('target');
  if (!target || !DEFINITIONS.has(target.text)) return null;
  const block = node.namedChildren.find((c) => c?.type === 'do_block');
  if (!block) return null;
  const indent = ' '.repeat(node.startPosition.column);
  return { node: block, text: `do\n${indent}  # ${placeholder}\n${indent}end` };
}

export const elixir: LanguageSpec = {
  id: 'elixir',
  fence: 'elixir',
  grammar: 'tree-sitter-elixir',
  extensions: ['.ex', '.exs'],
  bodyReplacement,
  candidates: ['call'],
};
