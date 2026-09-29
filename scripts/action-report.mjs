// Used by action.yml: turns --stats-json output into step outputs and a job summary.
import { appendFileSync, readFileSync } from 'node:fs';

const [statsPath, outputPath, summary] = process.argv.slice(2);
const stats = JSON.parse(readFileSync(statsPath, 'utf8'));
const cl = stats.tokens.cl100k_base;
const saved = Math.round(stats.savedRatio * 100);
const fmt = (n) => n.toLocaleString('en-US');

const outputs = {
  'output-path': outputPath,
  files: stats.files.included,
  tokens: cl.output,
  'raw-tokens': cl.baseline,
  'saved-percent': saved,
};
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([k, v]) => `${k}=${v}\n`).join(''));
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
console.log(`astpack: ${fmt(cl.output)} tokens (${saved}% saved) → ${outputPath}`);
