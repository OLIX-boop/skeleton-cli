import { extname } from 'node:path';
import type { LanguageId } from './types.js';

/** A region of a file containing code in a tree-sitter language. */
export interface EmbeddedRegion {
  start: number;
  end: number;
  language: LanguageId;
}

/** A multi-language file format whose script regions are skeletonized; markup is kept. */
export interface EmbeddedSpec {
  id: string;
  fence: string;
  extensions: readonly string[];
  regions(source: string): EmbeddedRegion[];
}

const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const LANG_ATTR = /\blang\s*=\s*["']?([a-z]+)/i;

function scriptLanguage(attrs: string, fallback: LanguageId): LanguageId | undefined {
  if (/\btype\s*=\s*["']?(application\/(ld\+)?json|text\/template|text\/x-template)/i.test(attrs)) return undefined;
  const lang = LANG_ATTR.exec(attrs)?.[1]?.toLowerCase();
  if (!lang) return fallback;
  if (lang === 'ts' || lang === 'typescript') return 'typescript';
  if (lang === 'tsx') return 'tsx';
  if (lang === 'js' || lang === 'javascript') return 'javascript';
  if (lang === 'jsx') return 'javascript';
  return undefined; // e.g. coffee
}

/** Find `<script>` element contents. */
export function scriptRegions(source: string, fallback: LanguageId = 'javascript'): EmbeddedRegion[] {
  const regions: EmbeddedRegion[] = [];
  for (const match of source.matchAll(SCRIPT)) {
    const language = scriptLanguage(match[1] ?? '', fallback);
    if (!language) continue;
    const start = match.index + match[0].indexOf('>') + 1;
    regions.push({ start, end: start + (match[2] ?? '').length, language });
  }
  return regions;
}

export const vue: EmbeddedSpec = {
  id: 'vue',
  fence: 'vue',
  extensions: ['.vue'],
  regions: (source) => scriptRegions(source),
};

export const svelte: EmbeddedSpec = {
  id: 'svelte',
  fence: 'svelte',
  extensions: ['.svelte'],
  regions: (source) => scriptRegions(source),
};

/** Astro: TypeScript frontmatter between `---` fences, plus `<script>` tags. */
export const astro: EmbeddedSpec = {
  id: 'astro',
  fence: 'astro',
  extensions: ['.astro'],
  regions(source) {
    const regions: EmbeddedRegion[] = [];
    const front = /^\s*---\r?\n([\s\S]*?)\r?\n---/.exec(source);
    let offset = 0;
    if (front) {
      const start = front[0].indexOf('\n') + 1;
      regions.push({ start, end: start + (front[1] ?? '').length, language: 'typescript' });
      offset = front[0].length;
    }
    for (const r of scriptRegions(source.slice(offset), 'typescript')) {
      regions.push({ start: r.start + offset, end: r.end + offset, language: r.language });
    }
    return regions;
  },
};

export const EMBEDDED: readonly EmbeddedSpec[] = [vue, svelte, astro];

const BY_EXTENSION = new Map(EMBEDDED.flatMap((spec) => spec.extensions.map((ext) => [ext, spec] as const)));

export function embeddedForPath(filePath: string): EmbeddedSpec | undefined {
  return BY_EXTENSION.get(extname(filePath).toLowerCase());
}
