import { extname } from 'node:path';
import type { LanguageId, LanguageSpec } from './types.js';
import { bash } from './bash.js';
import { c, cpp } from './c.js';
import { csharp } from './csharp.js';
import { dart } from './dart.js';
import { elixir } from './elixir.js';
import { go } from './go.js';
import { haskell } from './haskell.js';
import { java } from './java.js';
import { julia } from './julia.js';
import { kotlin } from './kotlin.js';
import { lua } from './lua.js';
import { objc } from './objc.js';
import { ocaml, ocamlInterface } from './ocaml.js';
import { php } from './php.js';
import { python } from './python.js';
import { ruby } from './ruby.js';
import { rust } from './rust.js';
import { scala } from './scala.js';
import { solidity } from './solidity.js';
import { swift } from './swift.js';
import { javascript, tsx, typescript } from './typescript.js';
import { zig } from './zig.js';

export type { BodyReplacement, LanguageId, LanguageSpec } from './types.js';
export { EMBEDDED, embeddedForPath, scriptRegions, type EmbeddedRegion, type EmbeddedSpec } from './embedded.js';

export const LANGUAGES: Readonly<Record<LanguageId, LanguageSpec>> = {
  typescript,
  tsx,
  javascript,
  python,
  go,
  rust,
  java,
  csharp,
  c,
  cpp,
  ruby,
  php,
  kotlin,
  swift,
  scala,
  dart,
  elixir,
  bash,
  lua,
  zig,
  haskell,
  ocaml,
  ocaml_interface: ocamlInterface,
  julia,
  solidity,
  objc,
};

const BY_EXTENSION = new Map<string, LanguageSpec>(
  Object.values(LANGUAGES).flatMap((spec) => spec.extensions.map((ext) => [ext, spec] as const)),
);

/**
 * Map extra file extensions (e.g. `.es6`) or exact file names (e.g. `Jenkinsfile`) to a
 * supported language. Applies to the whole process.
 */
export function registerExtensions(mapping: Readonly<Record<string, LanguageId>>): void {
  for (const [key, id] of Object.entries(mapping)) {
    const spec = LANGUAGES[id];
    if (!spec) throw new Error(`Unknown language "${id}" for ${key}`);
    registered[key] = id;
    if (key.startsWith('.')) BY_EXTENSION.set(key.toLowerCase(), spec);
    else BY_NAME.set(key, spec);
  }
}

const BY_NAME = new Map<string, LanguageSpec>();
const registered: Record<string, LanguageId> = {};

/** Every mapping added with `registerExtensions` (e.g. to replay it in a worker thread). */
export function registeredExtensions(): Readonly<Record<string, LanguageId>> {
  return { ...registered };
}

/** Resolve the language for a file path by extension, or `undefined` if unsupported. */
export function languageForPath(filePath: string): LanguageSpec | undefined {
  if (BY_NAME.size) {
    const name = filePath.slice(Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\')) + 1);
    const byName = BY_NAME.get(name);
    if (byName) return byName;
  }
  return BY_EXTENSION.get(extname(filePath).toLowerCase());
}
