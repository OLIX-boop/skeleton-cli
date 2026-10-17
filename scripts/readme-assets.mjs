// Generates the README's logo and savings chart as SVG, in a light and a dark variant
// (GitHub picks one with <picture> and prefers-color-scheme).
// Usage: node scripts/readme-assets.mjs  (numbers below come from `node scripts/benchmark.mjs`)
import { mkdirSync, writeFileSync } from 'node:fs';

const OUT = new URL('../docs/assets/', import.meta.url);
mkdirSync(OUT, { recursive: true });

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

const THEMES = {
  light: { ink: '#0A0A0A', muted: '#6B6B6B', track: '#E6E6E6', line: '#D4D4D4', bg: '#FFFFFF' },
  dark: { ink: '#F5F5F5', muted: '#A3A3A3', track: '#2E2E2E', line: '#3A3A3A', bg: '#0D1117' },
};

// cl100k_base tokens of the complete Markdown document (scripts/benchmark.mjs, astpack 0.3.0).
const BENCH = [
  { repo: 'colinhacks/zod', lang: 'TypeScript', raw: 2_536_174, packed: 516_274 },
  { repo: 'BurntSushi/ripgrep', lang: 'Rust', raw: 919_234, packed: 406_790 },
  { repo: 'psf/requests', lang: 'Python', raw: 720_633, packed: 86_133 },
  { repo: 'google/gson', lang: 'Java', raw: 523_215, packed: 267_312 },
  { repo: 'expressjs/express', lang: 'JavaScript', raw: 194_356, packed: 65_699 },
  { repo: 'spf13/cobra', lang: 'Go', raw: 168_269, packed: 48_168 },
];

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const short = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : `${Math.round(n / 1e3)}k`);

function logo(t) {
  // A brace pair holding a code line and two stripped "bodies": the skeleton idea, in one mark.
  const w = 360;
  const h = 96;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-labelledby="title">
  <title id="title">astpack</title>
  <g fill="none" stroke="${t.ink}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M30 14 C18 14 18 22 18 30 L18 40 C18 46 14 48 8 48 C14 48 18 50 18 56 L18 66 C18 74 18 82 30 82"/>
    <path d="M66 14 C78 14 78 22 78 30 L78 40 C78 46 82 48 88 48 C82 48 78 50 78 56 L78 66 C78 74 78 82 66 82"/>
  </g>
  <g fill="${t.ink}">
    <rect x="34" y="30" width="28" height="6" rx="3"/>
    <circle cx="38" cy="48" r="3.5"/><circle cx="48" cy="48" r="3.5"/><circle cx="58" cy="48" r="3.5"/>
    <rect x="34" y="60" width="18" height="6" rx="3"/>
  </g>
  <text x="112" y="62" font-family="${FONT}" font-size="46" font-weight="700" letter-spacing="-1.5" fill="${t.ink}">astpack</text>
</svg>
`;
}

function savingsChart(t) {
  const w = 760;
  const left = 190;
  const barW = 430;
  const rowH = 54;
  const top = 74;
  const h = top + BENCH.length * rowH + 34;
  const rows = BENCH.map((b, i) => {
    const y = top + i * rowH;
    const share = b.packed / b.raw;
    const filled = Math.max(8, Math.round(barW * share));
    const saved = Math.round((1 - share) * 100);
    return `
  <g>
    <title>${esc(b.repo)}: ${b.raw.toLocaleString('en-US')} tokens raw, ${b.packed.toLocaleString('en-US')} with astpack (−${saved}%)</title>
    <text x="0" y="${y + 14}" font-size="14" font-weight="600" fill="${t.ink}">${esc(b.repo)}</text>
    <text x="0" y="${y + 32}" font-size="12" fill="${t.muted}">${esc(b.lang)}</text>
    <rect x="${left}" y="${y + 4}" width="${barW}" height="16" rx="4" fill="${t.track}"/>
    <rect x="${left}" y="${y + 4}" width="${filled}" height="16" rx="4" fill="${t.ink}"/>
    <text x="${left}" y="${y + 38}" font-size="12" fill="${t.muted}" font-family="${MONO}">${short(b.raw)} → ${short(b.packed)} tokens</text>
    <text x="${w}" y="${y + 18}" font-size="20" font-weight="700" text-anchor="end" fill="${t.ink}">−${saved}%</text>
  </g>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="${FONT}" role="img" aria-labelledby="title desc">
  <title id="title">Tokens needed to send a whole repository to an LLM</title>
  <desc id="desc">For six open-source repositories, the share of tokens that remains after astpack's skeleton mode, compared with the raw source.</desc>
  <text x="0" y="22" font-size="18" font-weight="700" fill="${t.ink}">Tokens to send a whole repository</text>
  <text x="0" y="44" font-size="13" fill="${t.muted}">Whole track = raw source.  Filled part = what astpack sends (skeleton mode, default settings).</text>
  <line x1="0" y1="${top - 14}" x2="${w}" y2="${top - 14}" stroke="${t.line}" stroke-width="1"/>${rows}
  <text x="0" y="${h - 8}" font-size="11" fill="${t.muted}">cl100k_base tokens of the complete Markdown document, shallow clones. Reproduce: node scripts/benchmark.mjs</text>
</svg>
`;
}

for (const [name, theme] of Object.entries(THEMES)) {
  writeFileSync(new URL(`logo-${name}.svg`, OUT), logo(theme));
  writeFileSync(new URL(`savings-${name}.svg`, OUT), savingsChart(theme));
}
console.log('Wrote docs/assets/{logo,savings}-{light,dark}.svg');
