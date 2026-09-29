// Measures astpack's token savings on public repositories (shallow clones).
// Usage: npm run build && node scripts/benchmark.mjs [owner/repo ...]
import { cloneRemote, parseRemote } from '../dist/git.js';
import { pack } from '../dist/pack.js';
import { render } from '../dist/output/index.js';
import { TokenCounter } from '../dist/tokens/index.js';

const DEFAULT_REPOS = [
  ['expressjs/express', 'JavaScript'],
  ['colinhacks/zod', 'TypeScript'],
  ['psf/requests', 'Python'],
  ['spf13/cobra', 'Go'],
  ['BurntSushi/ripgrep', 'Rust'],
  ['google/gson', 'Java'],
];

const repos = process.argv.length > 2 ? process.argv.slice(2).map((r) => [r, '']) : DEFAULT_REPOS;
const counter = new TokenCounter();
const rows = [];

for (const [repo, language] of repos) {
  const spec = parseRemote(repo);
  process.stderr.write(`${repo}… `);
  const clone = await cloneRemote(spec);
  try {
    const started = performance.now();
    const variants = {};
    for (const [name, options] of [
      ['full', { mode: 'full' }],
      ['skeleton', { mode: 'skeleton' }],
      ['bare', { mode: 'skeleton', comments: 'none' }],
      ['outline', { mode: 'outline' }],
    ]) {
      const result = await pack(clone.dir, options);
      const document = render('markdown', result, { projectName: spec.name });
      variants[name] = { tokens: counter.count(document), files: result.files.length };
    }
    const seconds = (performance.now() - started) / 1000 / 4;
    const saved = (v) => `${Math.round((1 - v.tokens / variants.full.tokens) * 100)}%`;
    rows.push([
      `[${repo}](https://github.com/${repo})`,
      language,
      variants.full.files.toLocaleString('en-US'),
      variants.full.tokens.toLocaleString('en-US'),
      `${variants.skeleton.tokens.toLocaleString('en-US')} (−${saved(variants.skeleton)})`,
      `${variants.bare.tokens.toLocaleString('en-US')} (−${saved(variants.bare)})`,
      `${variants.outline.tokens.toLocaleString('en-US')} (−${saved(variants.outline)})`,
      `${seconds.toFixed(1)}s`,
    ]);
    process.stderr.write('done\n');
  } finally {
    await clone.cleanup();
  }
}
counter.free();

const header = ['Repository', 'Language', 'Files', 'Raw (--full)', 'Skeleton', 'Skeleton + --comments none', '--outline', 'Time'];
console.log(`| ${header.join(' | ')} |`);
console.log(`| ${header.map((h, i) => (i >= 2 ? '---:' : '---')).join(' | ')} |`);
for (const row of rows) console.log(`| ${row.join(' | ')} |`);
console.log('\nTokens counted with cl100k_base on the complete Markdown document, default ignore rules.');
