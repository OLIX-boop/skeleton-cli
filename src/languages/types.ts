import type { Node } from 'web-tree-sitter';

export type LanguageId = 'typescript' | 'tsx' | 'javascript';

/** A span of source text to be replaced in the skeleton output. */
export interface BodyReplacement {
  /** The node whose text is replaced. Its subtree is not visited further. */
  node: Node;
  /** Text inserted in place of the node. */
  text: string;
  /** Start offset of the replaced span, if it should begin before `node` (defaults to `node.startIndex`). */
  start?: number;
}

export interface LanguageSpec {
  id: LanguageId;
  /** Grammar file name inside `tree-sitter-wasms/out`, without extension. */
  grammar: string;
  /** File extensions (lowercase, with leading dot) handled by this language. */
  extensions: readonly string[];
  /**
   * Decide whether `node` owns an implementation body that should be stripped.
   * Return the replacement, or `null` to leave the node alone and keep walking.
   */
  bodyReplacement(node: Node, placeholder: string): BodyReplacement | null;
  /** Default placeholder text put inside a stripped body. */
  defaultPlaceholder: string;
}
