import type { Node } from 'web-tree-sitter';
import type { BodyReplacement, LanguageSpec } from './types.js';

/** Long enough that a one-line definition is worth replacing. */
const LONG_LINE = 80;

/**
 * Haskell: the right-hand sides of function and value definitions — every guard and
 * equation body, plus the `where` clause — become `= undefined {- ... -}` when they span
 * several lines or run long. Type signatures, data types, newtypes, classes, instances'
 * shapes, imports, exports and Haddock comments are kept, as are short one-liners.
 */
function bodyReplacement(node: Node, placeholder: string): BodyReplacement | null {
  if (node.type !== 'function' && node.type !== 'bind') return null;
  const first = node.childForFieldName('match');
  if (!first) return null;
  const rhs = node.text.slice(first.startIndex - node.startIndex);
  if (!rhs.includes('\n') && rhs.length <= LONG_LINE) return null;
  return { node, start: first.startIndex, end: node.endIndex, text: `= undefined {- ${placeholder.replace(/-}/g, '- }')} -}` };
}

/** The name a function or value definition binds. */
function boundName(node: Node): string | undefined {
  return node.childForFieldName('name')?.text;
}

export const haskell: LanguageSpec = {
  id: 'haskell',
  fence: 'haskell',
  grammar: 'tree-sitter-haskell',
  extensions: ['.hs'],
  bodyReplacement,
  candidates: ['function', 'bind'],
  outline: {
    containers: ['class', 'instance'],
    body: (node) => (node.type === 'class' || node.type === 'instance' ? node.childForFieldName('declarations') : undefined),
    declarations: ['signature', 'data_type', 'newtype', 'type_synomym', 'type_family', 'type_instance'],
    label(node) {
      if (node.type !== 'function' && node.type !== 'bind') return undefined;
      // Equations of a function with a type signature add nothing to the signature.
      for (let sib = node.previousNamedSibling; sib; sib = sib.previousNamedSibling) {
        if (sib.type === 'signature' && sib.childForFieldName('name')?.text === boundName(node)) return '';
        if (sib.type !== 'function' && sib.type !== 'bind' && sib.type !== 'haddock' && sib.type !== 'comment') break;
      }
      // No signature: the left-hand side (`h x y`), once per function.
      const previous = node.previousNamedSibling;
      if (previous && (previous.type === 'function' || previous.type === 'bind') && boundName(previous) === boundName(node)) return '';
      const match = node.childForFieldName('match');
      return match ? node.text.slice(0, match.startIndex - node.startIndex) : undefined;
    },
  },
};
