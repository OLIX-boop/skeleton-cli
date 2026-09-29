// Used by action.yml: turns --stats-json output into step outputs and a job summary.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

/** Mirrors partPath() in src/split.ts: out.md -> out.part2.md. */
function partPath(path, index) {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const dot = path.lastIndexOf('.');
  return dot > slash + 1 ? `${path.slice(0, dot)}.part${index}${path.slice(dot)}` : `${path}.part${index}`;
}

const [statsPath, outputPath, summary] = process.argv.slice(2);
const stats = JSON.parse(readFileSync(statsPath, 'utf8'));
const cl = stats.tokens.cl100k_base;
const saved = Math.round(stats.savedRatio * 100);
const fmt = (n) => n.toLocaleString('en-US');

// Which files the run actually wrote (parts with --split-tokens, none with --stdout/--dry-run).
const candidates = stats.parts ? stats.parts.map((_, i) => partPath(outputPath, i + 1)) : [outputPath];
const written = candidates.filter((p) => existsSync(p));

const outputs = {
  'output-path': written[0] ?? '',
  files: stats.files.included,
  tokens: cl.output,
  'raw-tokens': cl.baseline,
  'saved-percent': saved,
};
if (process.env.GITHUB_OUTPUT) {
  const lines = Object.entries(outputs).map(([k, v]) => `${k}=${v}\n`);
  lines.push(`output-paths<<ASTPACK_EOF\n${written.join('\n')}\nASTPACK_EOF\n`);
  appendFileSync(process.env.GITHUB_OUTPUT, lines.join(''));
}

if (summary === 'true' && process.env.GITHUB_STEP_SUMMARY) {
  const lines = [
    '### astpack',
    '',
    '| | |',
    '| --- | --- |',
    `| Files included | ${fmt(stats.files.included)} of ${fmt(stats.files.scanned)} scanned |`,
    `| Tokens (cl100k_base) | **${fmt(cl.output)}** (raw: ${fmt(cl.baseline)}, saved ${saved}%) |`,
    `| Tokens (o200k_base) | ${fmt(stats.tokens.o200k_base.output)} |`,
    ...stats.costs.map((c) => `| ${c.model} input cost | $${c.usd.toFixed(4)} |`),
    ...(stats.budget ? [`| Budget | ${fmt(stats.budget.tokens)} / ${fmt(stats.budget.maxTokens)} ${stats.budget.fits ? '✅' : '⚠️'} |`] : []),
    '',
    '<details><summary>Largest files</summary>',
    '',
    '| File | Tokens | Raw |',
    '| --- | ---: | ---: |',
    ...stats.filesByTokens.slice(0, 10).map((f) => `| \`${f.path}\` | ${fmt(f.tokens)} | ${fmt(f.rawTokens)} |`),
    '',
    '</details>',
    '',
  ];
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n'));
}
console.log(`astpack: ${fmt(cl.output)} tokens (${saved}% saved) → ${written.join(', ') || 'nothing written'}`);
