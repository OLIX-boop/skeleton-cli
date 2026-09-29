import { transformFile, type FallbackLimits } from './engine/transform.js';
import type { CommentMode } from './languages/types.js';
import { fenceForStrategy, type PackedFile, type PackResult } from './pack.js';
import { TokenCounter, type EncodingName } from './tokens/index.js';
import { TEST_PATH } from './util/paths.js';

/** One rung of the compression ladder. */
interface Level {
  name: 'full' | 'skeleton' | 'docs' | 'bare' | 'outline' | 'omitted';
  mode?: 'full' | 'skeleton' | 'outline';
  comments?: CommentMode;
}

export interface BudgetOptions {
  /** Token budget for the complete rendered document. */
  maxTokens: number;
  /** Renders a pack result to the final document (tokens are measured on this). */
  render: (result: PackResult) => string;
  /** Tokenizer to measure with. Default `cl100k_base`. */
  encoding?: EncodingName;
  /** The comment mode the pack was made with. */
  comments?: CommentMode;
  placeholder?: string;
  fallback?: Partial<FallbackLimits>;
  /** Whether to mask secrets in re-transformed files (default true). */
  redact?: boolean;
  counter?: TokenCounter;
}

export interface BudgetChange {
  path: string;
  from: string;
  to: string;
}

export interface BudgetReport {
  result: PackResult;
  document: string;
  tokens: number;
  maxTokens: number;
  fits: boolean;
  /** Tokens of the document before any compression. */
  initialTokens: number;
  changes: BudgetChange[];
  /** Tokens used by focus targets, which are never compressed (related files are). */
  focusTokens: number;
}

const DOC_PATH = /\.(md|mdx|rst|txt|adoc)$|(^|\/)(docs?|examples?)\//i;

/**
 * Lower is dropped first when files must be omitted: tests and fixtures, then docs and
 * examples, then other non-code files, then code.
 */
function omissionRank(file: PackedFile): number {
  if (TEST_PATH.test(file.path)) return 0;
  if (DOC_PATH.test(file.path)) return 1;
  if (!file.language) return 2;
  return 3;
}

function ladder(start: PackedFile, baseComments: CommentMode): Level[] {
  const levels: Level[] = [];
  if (start.strategy === 'outline') {
    levels.push({ name: 'outline', mode: 'outline' });
  } else if (start.strategy === 'full' && !start.language) {
    // Unsupported file: full -> truncated -> omitted.
    levels.push({ name: 'full', mode: 'full' }, { name: 'skeleton', mode: 'skeleton' });
  } else if (start.language) {
    if (start.strategy === 'full') levels.push({ name: 'full', mode: 'full', comments: baseComments });
    levels.push({ name: 'skeleton', mode: 'skeleton', comments: baseComments });
    if (baseComments === 'all') levels.push({ name: 'docs', mode: 'skeleton', comments: 'docs' });
    if (baseComments !== 'none') levels.push({ name: 'bare', mode: 'skeleton', comments: 'none' });
    levels.push({ name: 'outline', mode: 'outline' });
  } else {
    levels.push({ name: 'skeleton', mode: 'skeleton' });
  }
  levels.push({ name: 'omitted' });
  return levels;
}

interface Candidate {
  index: number;
  levels: Level[];
  level: number;
  /** Cache of transformed files per level. */
  variants: Map<number, { file: PackedFile; tokens: number }>;
}

/**
 * Compress a pack until its rendered document fits in `maxTokens`, degrading files one
 * phase at a time (full → skeleton → doc-comments only → no comments → outline → omitted) and
 * choosing the largest savings first within each phase. Focus targets are never touched;
 * files focused only as `related` are compressed after every other file.
 */
export async function fitToBudget(input: PackResult, options: BudgetOptions): Promise<BudgetReport> {
  const counter = options.counter ?? new TokenCounter();
  const encoding = options.encoding ?? 'cl100k_base';
  const baseComments = options.comments ?? 'all';
  try {
    const files = [...input.files];
    const current = () => ({ ...input, files: [...files] });
    let document = options.render(current());
    let tokens = counter.count(document, encoding);
    const initialTokens = tokens;
    const changes: BudgetChange[] = [];
    const focusTokens = files.filter((f) => f.focused && !f.related).reduce((n, f) => n + counter.count(f.content, encoding), 0);

    const candidates: Candidate[] = files
      .map((file, index) => ({ file, index }))
      .filter(({ file }) => !file.focused || file.related)
      .map(({ file, index }) => {
        const levels = ladder(file, baseComments);
        return {
          index,
          levels,
          level: 0,
          variants: new Map([[0, { file, tokens: counter.count(file.content, encoding) }]]),
        };
      });

    const variant = async (c: Candidate, level: number) => {
      const cached = c.variants.get(level);
      if (cached) return cached;
      // A compressed related file is no longer shown as full source.
      const base: PackedFile = { ...c.variants.get(0)!.file, focused: false };
      delete base.related;
      const target = c.levels[level]!;
      let file: PackedFile;
      if (target.name === 'omitted') {
        file = { ...base, content: '', strategy: 'omitted', strippedBodies: 0, strippedComments: 0, redactions: [] };
      } else {
        const t = await transformFile(base.path, base.original, {
          mode: target.mode!,
          comments: target.comments,
          placeholder: options.placeholder,
          fallback: options.fallback,
          redact: options.redact,
        });
        file = {
          ...base,
          content: t.content,
          strategy: t.strategy,
          fence: fenceForStrategy(t.strategy, base.fence),
          strippedBodies: t.strippedBodies,
          strippedComments: t.strippedComments,
          redactions: t.redactions,
          parseErrors: t.parseErrors,
        };
      }
      const v = { file, tokens: counter.count(file.content, encoding) };
      c.variants.set(level, v);
      return v;
    };

    const measure = () => {
      document = options.render(current());
      tokens = counter.count(document, encoding);
      return tokens;
    };

    // Each phase re-measures the exact document and applies just enough moves (largest
    // savings first) to cover the remaining gap; the legend and headings shift a little as
    // files change, so a few measurements per phase converge on the budget.
    const phases: Level['name'][] = ['skeleton', 'docs', 'bare', 'outline', 'omitted'];
    const isRelated = (c: Candidate) => !!c.variants.get(0)!.file.related;
    const tiers = [candidates.filter((c) => !isRelated(c)), candidates.filter(isRelated)];
    for (const [tier, phase] of tiers.flatMap((t) => phases.map((p) => [t, p] as const))) {
      if (tokens <= options.maxTokens) break;
      while (tokens > options.maxTokens) {
        const moves: { c: Candidate; to: number; saving: number; rank: number }[] = [];
        for (const c of tier) {
          const to = c.levels.findIndex((l, i) => i > c.level && l.name === phase);
          if (to === -1) continue;
          const now = c.variants.get(c.level)!.tokens;
          const next = await variant(c, to);
          // Omitting also drops the file's heading and fences (~12 tokens).
          const saving = now - next.tokens + (phase === 'omitted' ? 12 : 0);
          if (saving > 0) moves.push({ c, to, saving, rank: omissionRank(next.file) });
        }
        if (!moves.length) break;
        if (phase === 'omitted') moves.sort((a, b) => a.rank - b.rank || b.saving - a.saving);
        else moves.sort((a, b) => b.saving - a.saving);
        let gap = tokens - options.maxTokens;
        for (const move of moves) {
          if (gap <= 0) break;
          const from = move.c.levels[move.c.level]!.name;
          move.c.level = move.to;
          files[move.c.index] = move.c.variants.get(move.to)!.file;
          gap -= move.saving;
          changes.push({ path: files[move.c.index]!.path, from, to: phase });
        }
        measure();
      }
    }

    // Backfill: the greedy pass may overshoot, so restore omitted files (most valuable and
    // smallest first) into the remaining headroom, verifying with one exact count.
    if (tokens <= options.maxTokens) {
      const omitted = candidates
        .filter((c) => c.levels[c.level]!.name === 'omitted' && c.level > 0)
        .map((c) => ({ c, prev: c.level - 1, cost: c.variants.get(c.level - 1)!.tokens + 12, rank: omissionRank(c.variants.get(0)!.file) }))
        // Related files first: they were the last to be reduced.
        .sort((a, b) => Number(isRelated(b.c)) - Number(isRelated(a.c)) || b.rank - a.rank || a.cost - b.cost);
      let headroom = options.maxTokens - tokens;
      const restored: typeof omitted = [];
      for (const item of omitted) {
        if (item.cost > headroom) continue;
        headroom -= item.cost;
        restored.push(item);
        files[item.c.index] = item.c.variants.get(item.prev)!.file;
      }
      if (restored.length) {
        const doc = options.render(current());
        const exact = counter.count(doc, encoding);
        if (exact <= options.maxTokens) {
          document = doc;
          tokens = exact;
          for (const item of restored) {
            item.c.level = item.prev;
            changes.push({ path: files[item.c.index]!.path, from: 'omitted', to: item.c.levels[item.prev]!.name });
          }
        } else {
          for (const item of restored) files[item.c.index] = item.c.variants.get(item.c.level)!.file;
        }
      }
    }

    // Collapse per-file history to first → last level.
    const collapsed = new Map<string, BudgetChange>();
    for (const change of changes) {
      const prev = collapsed.get(change.path);
      const merged = prev ? { ...prev, to: change.to } : change;
      if (merged.from === merged.to) collapsed.delete(change.path);
      else collapsed.set(change.path, merged);
    }

    return {
      result: current(),
      document,
      tokens,
      maxTokens: options.maxTokens,
      fits: tokens <= options.maxTokens,
      initialTokens,
      changes: [...collapsed.values()],
      focusTokens,
    };
  } finally {
    if (!options.counter) counter.free();
  }
}
