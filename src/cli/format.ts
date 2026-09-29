export function formatNumber(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

export function formatUsd(usd: number): string {
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(ratio > 0 && ratio < 0.1 ? 1 : 0)}%`;
}

/** Parse sizes like `500`, `500kb`, `1.5MB`, `2m`. Returns bytes. */
export function parseSize(input: string): number {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([kmg]?)i?b?\s*$/i.exec(input);
  if (!match) throw new Error(`Invalid size: "${input}" (expected e.g. 500kb, 2mb)`);
  const value = Number(match[1]);
  const unit = (match[2] ?? '').toLowerCase();
  const factor = unit === 'k' ? 1024 : unit === 'm' ? 1024 ** 2 : unit === 'g' ? 1024 ** 3 : 1;
  return Math.round(value * factor);
}

export function parsePositiveInt(input: string): number {
  const n = Number(input);
  if (!Number.isInteger(n) || n < 0) throw new Error(`Expected a non-negative integer, got "${input}"`);
  return n;
}

/** Parse token counts like `50000`, `50k`, `1.5m`. */
export function parseTokenCount(input: string): number {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([km]?)\s*$/i.exec(input.replace(/[_,]/g, ''));
  if (!match) throw new Error(`Invalid token count: "${input}" (expected e.g. 50000, 100k, 1m)`);
  const factor = { '': 1, k: 1_000, m: 1_000_000 }[(match[2] ?? '').toLowerCase()] ?? 1;
  const n = Math.round(Number(match[1]) * factor);
  if (n <= 0) throw new Error('Token budget must be positive');
  return n;
}
