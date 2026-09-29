import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Language, Parser } from 'web-tree-sitter';
import type { LanguageSpec } from '../languages/index.js';

const require = createRequire(import.meta.url);

let initPromise: Promise<void> | undefined;
const languageCache = new Map<string, Promise<Language>>();
const parserCache = new Map<string, Parser>();

function grammarPath(grammar: string): string {
  const pkgDir = dirname(require.resolve('tree-sitter-wasms/package.json'));
  return join(pkgDir, 'out', `${grammar}.wasm`);
}

function init(): Promise<void> {
  initPromise ??= Parser.init();
  return initPromise;
}

async function loadLanguage(spec: LanguageSpec): Promise<Language> {
  await init();
  let lang = languageCache.get(spec.grammar);
  if (!lang) {
    lang = Language.load(grammarPath(spec.grammar));
    languageCache.set(spec.grammar, lang);
    // Allow a later retry if loading failed.
    lang.catch(() => languageCache.delete(spec.grammar));
  }
  return lang;
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
