import { visibleLength } from './colors.js';

export type Align = 'left' | 'right';

/** Render rows as an aligned, box-drawn table. */
export function table(rows: string[][], align: Align[] = [], header?: string[]): string {
  const all = header ? [header, ...rows] : rows;
  const cols = Math.max(0, ...all.map((r) => r.length));
  const widths = Array.from({ length: cols }, (_, c) => Math.max(0, ...all.map((r) => visibleLength(r[c] ?? ''))));
  const pad = (cell: string, c: number) => {
    const gap = ' '.repeat(widths[c]! - visibleLength(cell));
    return align[c] === 'right' ? gap + cell : cell + gap;
  };
  const line = (l: string, m: string, r: string) => l + widths.map((w) => '─'.repeat(w + 2)).join(m) + r;
  const row = (r: string[]) => '│' + widths.map((_, c) => ` ${pad(r[c] ?? '', c)} `).join('│') + '│';
  const out = [line('┌', '┬', '┐')];
  if (header) out.push(row(header), line('├', '┼', '┤'));
  for (const r of rows) out.push(row(r));
  out.push(line('└', '┴', '┘'));
  return out.join('\n');
}
