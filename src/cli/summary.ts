import type { BudgetReport } from '../budget.js';
import type { SearchHit } from '../search.js';
import type { PackStats } from '../tokens/index.js';
import type { Colors } from './colors.js';
import { formatBytes, formatNumber, formatPercent, formatUsd } from './format.js';
import { table } from './table.js';

export interface SummaryOptions {
  colors: Colors;
  /** How many of the largest files to list (0 hides the list). */
  top: number;
  outputLabel: string;
  mode: string;
  budget?: BudgetReport;
  /** Token counts of each part when the output was split. */
  parts?: number[];
  /** Files focused by `--query`. */
  queryHits?: SearchHit[];
}

const SKIP_LABELS: Record<string, string> = {
  ignored: 'ignored',
  'not-included': 'not in --include',
  'too-large': 'too large',
  binary: 'binary',
  symlink: 'symlink',
  unreadable: 'unreadable',
};

export function renderSummary(stats: PackStats, options: SummaryOptions): string {
  const c = options.colors;
  const out: string[] = [];
  const cl = stats.tokens.cl100k_base;
  const o2 = stats.tokens.o200k_base;

  const skippedTotal = Object.values(stats.skipped).reduce((a, b) => a + (b ?? 0), 0);
  const skippedDetail = Object.entries(stats.skipped)
    .map(([reason, n]) => `${n} ${SKIP_LABELS[reason] ?? reason}`)
    .join(', ');
  const strategyDetail = ['skeleton', 'outline', 'focus', 'full', 'truncated', 'omitted']
    .filter((k) => stats.byStrategy[k])
    .map((k) => `${stats.byStrategy[k]} ${k}`)
    .join(', ');

  const rows: string[][] = [
    ['Mode', options.mode],
    ['Files scanned', formatNumber(stats.entriesScanned)],
    ['Files included', `${formatNumber(stats.filesIncluded)}${strategyDetail ? c.dim(`  (${strategyDetail})`) : ''}`],
    ['Skipped', `${formatNumber(skippedTotal)}${skippedDetail ? c.dim(`  (${skippedDetail})`) : ''}`],
  ];
  if (stats.strippedBodies) rows.push(['Bodies stripped', formatNumber(stats.strippedBodies)]);
  if (stats.strippedComments) rows.push(['Comments stripped', formatNumber(stats.strippedComments)]);
  rows.push(
    ['Output size', `${formatBytes(stats.outputBytes)}${c.dim(`  (${formatNumber(stats.outputChars)} chars)`)}`],
    ['Tokens (cl100k_base)', `${c.bold(formatNumber(cl.output))}${c.dim(`  of ${formatNumber(cl.baseline)} raw`)}`],
    ['Tokens (o200k_base)', `${c.bold(formatNumber(o2.output))}${c.dim(`  of ${formatNumber(o2.baseline)} raw`)}`],
  );
  if (cl.baseline > cl.output) {
    rows.push(['Tokens saved', c.green(c.bold(formatPercent(stats.savedRatio)))]);
  }
  const budget = options.budget;
  if (budget) {
    const status = budget.fits ? c.green('✔ fits') : c.yellow('✘ over');
    const compressed = budget.changes.filter((ch) => ch.to !== 'omitted').length;
    const omitted = budget.changes.filter((ch) => ch.to === 'omitted').length;
    const detail = [compressed && `${compressed} compressed`, omitted && `${omitted} omitted`].filter(Boolean).join(', ');
    rows.push([
      'Token budget',
      `${formatNumber(budget.tokens)} / ${formatNumber(budget.maxTokens)} ${status}${detail ? c.dim(`  (${detail})`) : ''}`,
    ]);
  }
  if (options.parts && options.parts.length > 1) {
    rows.push(['Parts', `${options.parts.length}${c.dim(`  (${options.parts.map(formatNumber).join(' / ')} tokens)`)}`]);
  }
  out.push(c.bold('astpack summary'), table(rows, ['left', 'left']));

  if (stats.costs.length) {
    const costRows = stats.costs.map((cost) => [
      cost.model.label + (cost.model.approximate ? c.dim('*') : ''),
      formatNumber(cost.tokens),
      formatUsd(cost.usd),
      cost.baselineUsd > cost.usd ? c.dim(formatUsd(cost.baselineUsd)) : c.dim('-'),
    ]);
    out.push('', table(costRows, ['left', 'right', 'right', 'right'], ['Model', 'Input tokens', 'Cost', 'Raw cost']));
    if (stats.costs.some((x) => x.model.approximate)) {
      out.push(
        c.dim('* Estimated with cl100k_base; Claude tokenizes typically 15-20% higher (more on code). Use --claude-tokens for exact counts.'),
      );
    }
  }

  if (options.queryHits) {
    if (options.queryHits.length) {
      const rows = options.queryHits.map((h) => [h.path, c.dim(h.matched.join(', '))]);
      out.push('', table(rows, ['left', 'left'], ['Query matches', 'Words']));
    } else {
      out.push('', c.yellow('⚠ No files matched --query.'));
    }
  }

  if (options.top > 0 && stats.files.length) {
    const top = stats.files.slice(0, options.top).map((f) => [
      f.path + (f.related ? c.magenta(' [related]') : f.matched ? c.magenta(' [match]') : f.focused ? c.magenta(' [focus]') : ''),
      formatNumber(f.tokens),
      f.originalTokens > f.tokens ? c.green(formatPercent(1 - f.tokens / f.originalTokens)) : c.dim('-'),
    ]);
    out.push('', table(top, ['left', 'right', 'right'], [`Top ${top.length} files`, 'Tokens', 'Saved']));
  }

  if (stats.redactedFiles.length) {
    const total = stats.redactedFiles.reduce((n, f) => n + f.count, 0);
    const shown = stats.redactedFiles.slice(0, 5).map((f) => f.path).join(', ');
    const more = stats.redactedFiles.length > 5 ? ` and ${stats.redactedFiles.length - 5} more` : '';
    out.push('', c.yellow(`⚠ Masked ${total} likely secret${total === 1 ? '' : 's'} in ${shown}${more} (disable with --no-redact).`));
  }

  if (stats.parseErrorFiles.length) {
    const shown = stats.parseErrorFiles.slice(0, 5).join(', ');
    const more = stats.parseErrorFiles.length > 5 ? ` and ${stats.parseErrorFiles.length - 5} more` : '';
    out.push('', c.yellow(`⚠ Syntax errors while parsing ${shown}${more}; their skeletons are best-effort.`));
  }

  out.push('', `${c.green('✔')} ${options.outputLabel}`);
  return out.join('\n');
}
