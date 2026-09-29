import type { PackResult } from '../pack.js';
import type { SkipReason } from '../walker/index.js';
import { TokenCounter } from './counter.js';
import { costUsd, findModel, type EncodingName, type ModelPricing } from './pricing.js';

export interface FileTokens {
  path: string;
  /** Tokens (cl100k_base) of the packaged content. */
  tokens: number;
  /** Tokens (cl100k_base) of the original source. */
  originalTokens: number;
  strategy: string;
  focused: boolean;
}

export interface EncodingTotals {
  /** Tokens of the complete output document. */
  output: number;
  /**
   * Estimated tokens of the same document if every file had been included raw: the output
   * total plus the difference between original and packaged file contents.
   */
  baseline: number;
}

export interface ModelCost {
  model: ModelPricing;
  tokens: number;
  usd: number;
  baselineUsd: number;
}

export interface PackStats {
  filesIncluded: number;
  /** Included files plus skipped entries (an ignored directory counts once). */
  entriesScanned: number;
  skipped: Partial<Record<SkipReason, number>>;
  byStrategy: Record<string, number>;
  strippedBodies: number;
  strippedComments: number;
  /** Files with masked secrets and how many were masked in each. */
  redactedFiles: { path: string; count: number }[];
  parseErrorFiles: string[];
  outputChars: number;
  outputBytes: number;
  tokens: Record<EncodingName, EncodingTotals>;
  /** Share of baseline tokens removed (0..1), measured with cl100k_base. */
  savedRatio: number;
  costs: ModelCost[];
  /** Files sorted by packaged token count, descending. */
  files: FileTokens[];
}

export interface StatsOptions {
  /** Model ids to price (see `MODELS`). Unknown ids are ignored. */
  models?: readonly string[];
  /** Reuse an existing counter (it is not freed). */
  counter?: TokenCounter;
}

/** Compute token, savings and cost analytics for a rendered pack. */
export function computeStats(result: PackResult, output: string, options: StatsOptions = {}): PackStats {
  const counter = options.counter ?? new TokenCounter();
  try {
    const files: FileTokens[] = [];
    let delta = 0;
    for (const file of result.files) {
      const packed = counter.count(file.content, 'cl100k_base');
      const original = file.content === file.original ? packed : counter.count(file.original, 'cl100k_base');
      delta += original - packed;
      files.push({ path: file.path, tokens: packed, originalTokens: original, strategy: file.strategy, focused: file.focused });
    }
    const clOutput = counter.count(output, 'cl100k_base');
    const o2Output = counter.count(output, 'o200k_base');
    const clBaseline = clOutput + delta;
    // Per-file counts are only needed for one encoding; the o200k baseline is scaled from
    // the cl100k ratio (both tokenizers compress source code very similarly).
    const tokens: Record<EncodingName, EncodingTotals> = {
      cl100k_base: { output: clOutput, baseline: clBaseline },
      o200k_base: { output: o2Output, baseline: clOutput > 0 ? Math.round((o2Output * clBaseline) / clOutput) : o2Output },
    };

    const models = (options.models ?? []).map(findModel).filter((m): m is ModelPricing => !!m);
    const costs = models.map((model) => {
      const t = tokens[model.encoding];
      return { model, tokens: t.output, usd: costUsd(t.output, model), baselineUsd: costUsd(t.baseline, model) };
    });

    const skipped: Partial<Record<SkipReason, number>> = {};
    for (const s of result.skipped) skipped[s.reason] = (skipped[s.reason] ?? 0) + 1;
    const byStrategy: Record<string, number> = {};
    for (const f of result.files) {
      const key = f.focused ? 'focus' : f.strategy;
      byStrategy[key] = (byStrategy[key] ?? 0) + 1;
    }

    const cl = tokens.cl100k_base;
    return {
      filesIncluded: result.files.length,
      entriesScanned: result.files.length + result.skipped.length,
      skipped,
      byStrategy,
      strippedBodies: result.files.reduce((n, f) => n + f.strippedBodies, 0),
      strippedComments: result.files.reduce((n, f) => n + f.strippedComments, 0),
      redactedFiles: result.files.filter((f) => f.redactions.length).map((f) => ({ path: f.path, count: f.redactions.length })),
      parseErrorFiles: result.files.filter((f) => f.parseErrors).map((f) => f.path),
      outputChars: output.length,
      outputBytes: Buffer.byteLength(output),
      tokens,
      savedRatio: cl.baseline > 0 ? Math.max(0, 1 - cl.output / cl.baseline) : 0,
      costs,
      files: files.sort((a, b) => b.tokens - a.tokens || (a.path < b.path ? -1 : 1)),
    };
  } finally {
    if (!options.counter) counter.free();
  }
}
