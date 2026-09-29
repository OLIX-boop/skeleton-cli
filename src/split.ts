import type { PackedFile, PackResult } from './pack.js';
import type { RenderOptions } from './output/index.js';
import { TokenCounter, type EncodingName } from './tokens/index.js';

export interface SplitOptions {
  /** Maximum tokens per part. */
  maxTokens: number;
  /** Render one part. */
  render: (result: PackResult, part: NonNullable<RenderOptions['part']>) => string;
  encoding?: EncodingName;
  counter?: TokenCounter;
}

export interface SplitPart {
  index: number;
  files: PackedFile[];
  document: string;
  tokens: number;
}

export interface SplitReport {
  parts: SplitPart[];
  /** Files that exceed the limit on their own (each ends up alone in an oversized part). */
  oversized: string[];
}

/** Per-file cost in a part beyond its content: heading, fences and blank lines. */
const FILE_OVERHEAD = 12;

/**
 * Split a pack into documents of at most `maxTokens` tokens each, cutting only between files
 * and keeping their order. Part 1 carries the tree, instructions and diff.
 */
export function splitPack(result: PackResult, options: SplitOptions): SplitReport {
  const counter = options.counter ?? new TokenCounter();
  const encoding = options.encoding ?? 'cl100k_base';
  try {
    const allFiles = result.files;
    const withFiles = (files: PackedFile[]) => ({ ...result, files });
    const renderPart = (files: PackedFile[], index: number, total: number) =>
      options.render(withFiles(files), { index, total, allFiles });

    const costs = allFiles.map((f) => (f.strategy === 'omitted' ? 0 : counter.count(f.content, encoding) + FILE_OVERHEAD));
    // Fixed cost of an empty part: part 1 carries the tree etc., later parts only a header.
    const firstOverhead = counter.count(renderPart([], 1, 2), encoding);
    const laterOverhead = counter.count(renderPart([], 2, 2), encoding);

    const groups: PackedFile[][] = [];
    const oversized: string[] = [];
    let current: PackedFile[] = [];
    let used = firstOverhead;
    allFiles.forEach((file, i) => {
      const cost = costs[i]!;
      const overhead = groups.length === 0 ? firstOverhead : laterOverhead;
      if (current.length && used + cost > options.maxTokens) {
        groups.push(current);
        current = [];
        used = laterOverhead;
      }
      if (overhead + cost > options.maxTokens) oversized.push(file.path);
      current.push(file);
      used += cost;
    });
    if (current.length || !groups.length) groups.push(current);

    // Render with the real total and fix up any part the estimate got wrong by moving its
    // last files forward.
    for (let pass = 0; pass < 3; pass++) {
      let moved = false;
      for (let g = 0; g < groups.length; g++) {
        const files = groups[g]!;
        while (files.length > 1 && counter.count(renderPart(files, g + 1, groups.length), encoding) > options.maxTokens) {
          const last = files.pop()!;
          if (g + 1 === groups.length) groups.push([]);
          groups[g + 1]!.unshift(last);
          moved = true;
        }
      }
      if (!moved) break;
    }

    const total = groups.length;
    const parts = groups.map((files, i) => {
      const document = renderPart(files, i + 1, total);
      return { index: i + 1, files, document, tokens: counter.count(document, encoding) };
    });
    return { parts, oversized };
  } finally {
    if (!options.counter) counter.free();
  }
}

/** `out.md` → `out.part2.md`. */
export function partPath(path: string, index: number): string {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const dot = path.lastIndexOf('.');
  return dot > slash + 1 ? `${path.slice(0, dot)}.part${index}${path.slice(dot)}` : `${path}.part${index}`;
}
