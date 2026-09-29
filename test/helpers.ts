import { expect } from 'vitest';
import { skeletonize, type LanguageId } from '../src/index.js';

export const P = '{ /* ... */ }';

export async function skel(source: string, lang: LanguageId) {
  return (await skeletonize(source, lang)).code;
}

/** Skeleton output should itself be syntactically valid and idempotent. */
export async function expectValid(source: string, lang: LanguageId) {
  const once = await skeletonize(source, lang);
  expect(once.hasErrors).toBe(false);
  const reparsed = await skeletonize(once.code, lang);
  expect(reparsed.hasErrors).toBe(false);
  expect(reparsed.code).toBe(once.code);
  expect(reparsed.strippedBodies).toBe(0);
  return once;
}
