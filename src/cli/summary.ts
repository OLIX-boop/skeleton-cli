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
  const strategyDetail = ['skeleton', 'focus', 'full', 'truncated']
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
      out.push(c.dim('* Claude token counts are estimated with cl100k_base; Claude uses its own tokenizer.'));
    }
  }

  if (options.top > 0 && stats.files.length) {
    const top = stats.files.slice(0, options.top).map((f) => [
      f.path + (f.focused ? c.magenta(' [focus]') : ''),
      formatNumber(f.tokens),
      f.originalTokens > f.tokens ? c.green(formatPercent(1 - f.tokens / f.originalTokens)) : c.dim('-'),
    ]);
    out.push('', table(top, ['left', 'right', 'right'], [`Top ${top.length} files`, 'Tokens', 'Saved']));
  }

  if (stats.parseErrorFiles.length) {
    const shown = stats.parseErrorFiles.slice(0, 5).join(', ');
    const more = stats.parseErrorFiles.length > 5 ? ` and ${stats.parseErrorFiles.length - 5} more` : '';
    out.push('', c.yellow(`⚠ Syntax errors while parsing ${shown}${more}; their skeletons are best-effort.`));
  }

  out.push('', `${c.green('✔')} ${options.outputLabel}`);
  return out.join('\n');
}
