import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliDecompressSync } from 'node:zlib';
import { Language, Parser } from 'web-tree-sitter';
import type { LanguageSpec } from '../languages/index.js';
import { IMPORT_RENAMES, renameImports } from './wasm-patch.js';

const require = createRequire(import.meta.url);

let initPromise: Promise<void> | undefined;
const languageCache = new Map<string, Promise<Language>>();
const parserCache = new Map<string, Parser>();

/** Vendored, brotli-compressed grammars shipped with the package (see scripts/vendor-grammars.mjs). */
const VENDORED_DIR = fileURLToPath(new URL('../../grammars/', import.meta.url));

/**
 * Load a grammar's WASM bytes: the vendored copy when present, otherwise the
 * `tree-sitter-wasms` dev dependency (when running from source).
 */
async function grammarBytes(grammar: string): Promise<Uint8Array> {
  const vendored = join(VENDORED_DIR, `${grammar}.wasm.br`);
  if (existsSync(vendored)) return brotliDecompressSync(await readFile(vendored));
  if (process.env.ASTPACK_REQUIRE_VENDORED) throw new Error(`Vendored grammar missing: ${vendored}`);
  let pkgDir: string;
  try {
    pkgDir = dirname(require.resolve('tree-sitter-wasms/package.json'));
  } catch {
    throw new Error(`Grammar ${grammar} not found: run \`npm run build\` to vendor grammars, or install tree-sitter-wasms`);
  }
  return readFile(join(pkgDir, 'out', `${grammar}.wasm`));
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
