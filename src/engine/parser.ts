import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliDecompressSync } from 'node:zlib';
import { Language, Parser, type Tree } from 'web-tree-sitter';
import type { LanguageSpec } from '../languages/index.js';
import { IMPORT_RENAMES, renameImports } from './wasm-patch.js';

let initPromise: Promise<void> | undefined;
const languageCache = new Map<string, Promise<Language>>();
const parserCache = new Map<string, Parser>();

/**
 * Grammars ship with the package as brotli-compressed WASM (see scripts/vendor-grammars.mjs
 * and grammars/manifest.json for the exact upstream versions).
 */
const GRAMMAR_DIR = fileURLToPath(new URL('../../grammars/', import.meta.url));

async function grammarBytes(grammar: string): Promise<Uint8Array> {
  const file = join(GRAMMAR_DIR, `${grammar}.wasm.br`);
  if (!existsSync(file)) throw new Error(`Grammar ${grammar} is missing from ${GRAMMAR_DIR} (run \`node scripts/vendor-grammars.mjs\`)`);
  return brotliDecompressSync(await readFile(file));
}

function init(): Promise<void> {
  initPromise ??= Parser.init();
  return initPromise;
}

async function loadLanguage(spec: LanguageSpec): Promise<Language> {
  await init();
  let lang = languageCache.get(spec.grammar);
  if (!lang) {
    lang = grammarBytes(spec.grammar).then((bytes) => Language.load(renameImports(bytes, IMPORT_RENAMES)));
    languageCache.set(spec.grammar, lang);
    // Allow a later retry if loading failed.
    lang.catch(() => languageCache.delete(spec.grammar));
  }
  return lang;
}

/**
 * Drop the cached parser for a language, e.g. after a grammar's scanner trapped mid-parse
 * and left it in an unknown state.
 */
export function resetParser(spec: LanguageSpec): void {
  const parser = parserCache.get(spec.grammar);
  parserCache.delete(spec.grammar);
  try {
    parser?.delete();
  } catch {
    // already unusable
  }
}

/** Get a (cached) parser configured for the given language. */
export async function getParser(spec: LanguageSpec): Promise<Parser> {
  const language = await loadLanguage(spec);
  let parser = parserCache.get(spec.grammar);
  if (!parser) {
    parser = new Parser();
    parser.setLanguage(language);
    parserCache.set(spec.grammar, parser);
  }
  return parser;
}

export interface Parsed {
  tree: Tree;
  /** The text the tree was built from: the source, or its offset-preserving `preprocess` rewrite. */
  text: string;
}

/**
 * Parse `source`, retrying on the language's `preprocess` rewrite when the first parse has
 * syntax errors and the rewrite parses cleanly. The caller owns (and must delete) the tree.
 */
export async function parseSource(spec: LanguageSpec, source: string): Promise<Parsed> {
  const parser = await getParser(spec);
  let tree: Tree | null = null;
  try {
    tree = parser.parse(source);
    if (!tree) throw new Error(`Failed to parse source as ${spec.id}`);
    if (tree.rootNode.hasError && spec.preprocess) {
      const rewritten = spec.preprocess(source);
      if (rewritten !== source && rewritten.length === source.length) {
        const retry = parser.parse(rewritten);
        if (retry && !retry.rootNode.hasError) {
          tree.delete();
          return { tree: retry, text: rewritten };
        }
        retry?.delete();
      }
    }
    return { tree, text: source };
  } catch (error) {
    tree?.delete();
    if ((error as Error).message.startsWith('Failed to parse')) throw error;
    resetParser(spec);
    throw new Error(`The ${spec.id} parser crashed: ${(error as Error).message}`);
  }
}
