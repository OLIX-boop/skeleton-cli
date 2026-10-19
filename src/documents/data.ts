/**
 * Data files outside full mode: a sample instead of the first few hundred lines. CSV and TSV
 * keep the header and some rows; JSON keeps its shape with long arrays shortened; JSON Lines
 * keep a few records; SVG images become a one-line description. Small files are untouched.
 */

/** Files at or below this size are kept whole. */
const SMALL = 4096;
/** JSON is often configuration (package.json, tsconfig.json): only sample what would be cut anyway. */
const SMALL_JSON = 16_000;

function extension(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot === -1 ? '' : path.slice(dot + 1).toLowerCase();
}

export function isDataFile(path: string): boolean {
  return ['csv', 'tsv', 'json', 'jsonl', 'ndjson', 'geojson', 'svg'].includes(extension(path));
}

function sampleLines(content: string, keep: number, what: string): string | undefined {
  const lines = content.replace(/\n+$/, '').split('\n');
  if (lines.length <= keep + 1) return undefined;
  return `${lines.slice(0, keep + 1).join('\n')}\n… [${lines.length - keep - 1} more ${what}, ${lines.length - 1} in total]\n`;
}

function sampleCsv(content: string, separator: string): string | undefined {
  const sampled = sampleLines(content, 20, 'rows');
  if (!sampled) return undefined;
  const header = content.slice(0, content.indexOf('\n')).split(separator);
  return header.length > 1 ? sampled.replace(/\n$/, ` (${header.length} columns)\n`) : sampled;
}

/** Shorten long arrays and strings, keeping every key (the shape is what matters). */
function shrink(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return value.length > 200 ? `${value.slice(0, 160)}… [${value.length} chars]` : value;
  if (Array.isArray(value)) {
    const keep = depth > 3 ? 1 : 3;
    const head = value.slice(0, keep).map((v) => shrink(v, depth + 1));
    return value.length > keep ? [...head, `… ${value.length - keep} more items (${value.length} in total)`] : head;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    const entries = Object.entries(value);
    // Objects used as maps (thousands of keys) are shortened like arrays.
    const keep = entries.length > 50 ? 20 : entries.length;
    for (const [k, v] of entries.slice(0, keep)) out[k] = shrink(v, depth + 1);
    if (entries.length > keep) out['…'] = `${entries.length - keep} more keys (${entries.length} in total)`;
    return out;
  }
  return value;
}

function sampleJson(content: string): string | undefined {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return undefined;
  }
  const out = `${JSON.stringify(shrink(value, 0), null, 2)}\n`;
  return out.length < content.length * 0.8 ? out : undefined;
}

function describeSvg(content: string): string {
  const svg = /<svg\b[^>]*>/i.exec(content)?.[0] ?? '';
  const attr = (name: string) => new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(svg)?.[1];
  const size = attr('width') && attr('height') ? `${attr('width')}×${attr('height')}` : attr('viewBox') ? `viewBox ${attr('viewBox')}` : '';
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(content)?.[1]?.trim();
  const text = [...content.matchAll(/<text\b[^>]*>([^<]+)</gi)].map((m) => m[1]!.trim()).filter(Boolean).slice(0, 20);
  const parts = [`[SVG image${size ? ` ${size}` : ''}, ${Math.round(content.length / 1024)} KB${title ? `: ${title}` : ''}]`];
  if (text.length) parts.push(`Text: ${text.join(' · ')}`);
  return `${parts.join('\n')}\n`;
}

/** A condensed version of a data file, or `undefined` to fall back to the usual handling. */
export function condenseData(path: string, content: string): string | undefined {
  if (content.length <= SMALL) return undefined;
  switch (extension(path)) {
    case 'csv':
      return sampleCsv(content, ',');
    case 'tsv':
      return sampleCsv(content, '\t');
    case 'jsonl':
    case 'ndjson':
      return sampleLines(content, 5, 'records');
    case 'json':
    case 'geojson':
      return content.length > SMALL_JSON ? sampleJson(content) : undefined;
    case 'svg':
      return describeSvg(content);
    default:
      return undefined;
  }
}
