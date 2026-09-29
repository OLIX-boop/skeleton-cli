import { extname } from 'node:path';
import type { LanguageId, LanguageSpec } from './types.js';
import { bash } from './bash.js';
import { c, cpp } from './c.js';
import { csharp } from './csharp.js';
import { dart } from './dart.js';
import { elixir } from './elixir.js';
import { go } from './go.js';
import { java } from './java.js';
import { kotlin } from './kotlin.js';
import { php } from './php.js';
import { python } from './python.js';
import { ruby } from './ruby.js';
import { rust } from './rust.js';
import { scala } from './scala.js';
import { swift } from './swift.js';
import { javascript, tsx, typescript } from './typescript.js';

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
};

const BY_EXTENSION = new Map<string, LanguageSpec>(
  Object.values(LANGUAGES).flatMap((spec) => spec.extensions.map((ext) => [ext, spec] as const)),
);

/** Resolve the language for a file path by extension, or `undefined` if unsupported. */
export function languageForPath(filePath: string): LanguageSpec | undefined {
  return BY_EXTENSION.get(extname(filePath).toLowerCase());
}
