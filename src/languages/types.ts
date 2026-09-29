import type { Node } from 'web-tree-sitter';

export type LanguageId =
  | 'typescript'
  | 'tsx'
  | 'javascript'
  | 'python'
  | 'go'
  | 'rust'
  | 'java'
  | 'csharp'
  | 'c'
  | 'cpp'
  | 'ruby'
  | 'php'
  | 'kotlin'
  | 'swift'
  | 'scala'
  | 'dart'
  | 'elixir'
  | 'bash'
  | 'lua';

/** A span of source text to be replaced in the skeleton output. */
export interface BodyReplacement {
  /** The node whose text is replaced. Its subtree is not visited further. */
  node: Node;
  /** Text inserted in place of the node. */
  text: string;
  /** Start offset of the replaced span (defaults to `node.startIndex`). */
  start?: number;
  /** End offset of the replaced span (defaults to `node.endIndex`). */
  end?: number;
}

/** How much commentary to keep: everything, documentation comments only, or nothing. */
export type CommentMode = 'all' | 'docs' | 'none';

/** Context passed to language rules. */
export interface RuleContext {
  placeholder: string;
  comments: CommentMode;
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
   *
   * `placeholder` is the human-readable marker text (e.g. `...`); the language wraps it
   * in whatever syntax keeps the output valid (a block comment, `...`, etc.).
   */
  bodyReplacement(node: Node, placeholder: string, context: RuleContext): BodyReplacement | null;
  /**
   * Node types `bodyReplacement` may act on. The walker only materializes nodes of these
   * types, which keeps large files fast.
   */
  candidates: readonly string[];
  /**
   * Language-specific documentation nodes that are not comments (e.g. Python docstrings).
   * Returns the text to put in their place when documentation is stripped ('' to delete),
   * or `undefined` if `node` is not documentation.
   */
  docReplacement?(node: Node): string | undefined;
  /** Node types `docReplacement` may act on. */
  docCandidates?: readonly string[];
  /** Symbol outline rules (see engine/outline.ts). */
  outline?: {
    /** Types whose members are listed nested under a header (classes, modules, impls…). */
    containers?: readonly string[];
    /** Types summarised by their first line (type aliases, enums, structs…). */
    declarations?: readonly string[];
    /** Like `declarations`, but only inside a container (interface members, trait methods…). */
    members?: readonly string[];
    /** Dynamic container check, for grammars where containers are generic calls (Elixir). */
    isContainer?(node: Node): boolean;
    /**
     * Custom line for a node: a string to list it (`''` to skip it silently), or `undefined`
     * to fall back to the generic rules. Used where node types alone are ambiguous (C).
     */
    label?(node: Node, depth: number, source: string): string | undefined;
  };
  /** Language name used for Markdown code fences. */
  fence: string;
}
