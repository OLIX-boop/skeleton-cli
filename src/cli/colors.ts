export interface Colors {
  bold(s: string): string;
  dim(s: string): string;
  green(s: string): string;
  yellow(s: string): string;
  red(s: string): string;
  cyan(s: string): string;
  magenta(s: string): string;
}

const wrap = (open: number, close: number) => (s: string) => `\u001b[${open}m${s}\u001b[${close}m`;
const identity = (s: string) => s;

export function makeColors(enabled: boolean): Colors {
  if (!enabled) {
    return { bold: identity, dim: identity, green: identity, yellow: identity, red: identity, cyan: identity, magenta: identity };
  }
  return {
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    green: wrap(32, 39),
    yellow: wrap(33, 39),
    red: wrap(31, 39),
    cyan: wrap(36, 39),
    magenta: wrap(35, 39),
  };
}

/** Colour is on for TTYs unless NO_COLOR is set; FORCE_COLOR forces it on. */
export function shouldColor(stream: NodeJS.WriteStream): boolean {
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') return true;
  if (process.env.NO_COLOR !== undefined) return false;
  return !!stream.isTTY;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

export function visibleLength(s: string): number {
  return s.replace(ANSI, '').length;
}
