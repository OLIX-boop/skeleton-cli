import { extname } from 'node:path';
import type { LanguageId, LanguageSpec } from './types.js';
import { javascript, tsx, typescript } from './typescript.js';

export type { BodyReplacement, LanguageId, LanguageSpec } from './types.js';

export const LANGUAGES: Readonly<Record<LanguageId, LanguageSpec>> = {
  typescript,
  tsx,
  javascript,
};

const BY_EXTENSION = new Map<string, LanguageSpec>(
  Object.values(LANGUAGES).flatMap((spec) => spec.extensions.map((ext) => [ext, spec] as const)),
);

/** Resolve the language for a file path by extension, or `undefined` if unsupported. */
export function languageForPath(filePath: string): LanguageSpec | undefined {
  return BY_EXTENSION.get(extname(filePath).toLowerCase());
}
