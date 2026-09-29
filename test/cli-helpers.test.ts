import { describe, expect, it } from 'vitest';
import { clipboardCommands } from '../src/cli/clipboard.js';
import { makeColors, shouldColor, visibleLength } from '../src/cli/colors.js';
import { parsePositiveInt, parseTokenCount } from '../src/cli/format.js';

describe('clipboardCommands', () => {
  it('picks the platform tools in order', () => {
    expect(clipboardCommands('darwin', {}).map((c) => c.cmd)).toEqual(['pbcopy']);
    expect(clipboardCommands('win32', {}).map((c) => c.cmd)).toEqual(['powershell.exe', 'clip']);
    expect(clipboardCommands('linux', {}).map((c) => c.cmd)).toEqual(['xclip', 'xsel', 'termux-clipboard-set']);
    expect(clipboardCommands('linux', { WAYLAND_DISPLAY: 'wayland-0', WSL_DISTRO_NAME: 'Ubuntu' }).map((c) => c.cmd)).toEqual([
      'wl-copy',
      'xclip',
      'xsel',
      'termux-clipboard-set',
      'clip.exe',
    ]);
  });
});

describe('colors', () => {
  const tty = { isTTY: true } as NodeJS.WriteStream;
  const pipe = { isTTY: false } as NodeJS.WriteStream;

  it('follows TTY, NO_COLOR and FORCE_COLOR', () => {
    const saved = { NO_COLOR: process.env.NO_COLOR, FORCE_COLOR: process.env.FORCE_COLOR };
    try {
      delete process.env.NO_COLOR;
      delete process.env.FORCE_COLOR;
      expect(shouldColor(tty)).toBe(true);
      expect(shouldColor(pipe)).toBe(false);
      process.env.NO_COLOR = '1';
      expect(shouldColor(tty)).toBe(false);
      process.env.FORCE_COLOR = '1';
      expect(shouldColor(pipe)).toBe(true);
      process.env.FORCE_COLOR = '0';
      expect(shouldColor(tty)).toBe(false);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('measures visible length ignoring ANSI codes', () => {
    const c = makeColors(true);
    expect(visibleLength(c.bold(c.green('abc')))).toBe(3);
    expect(makeColors(false).red('x')).toBe('x');
  });
});

describe('number parsing', () => {
  it('parses integers and token counts', () => {
    expect(parsePositiveInt('12')).toBe(12);
    expect(() => parsePositiveInt('-1')).toThrow(/non-negative integer/);
    expect(() => parsePositiveInt('1.5')).toThrow();
    expect(parseTokenCount('100k')).toBe(100_000);
    expect(parseTokenCount('1.5m')).toBe(1_500_000);
    expect(parseTokenCount('32_000')).toBe(32_000);
    expect(() => parseTokenCount('0')).toThrow(/positive/);
  });
});
