import { resolve } from 'node:path';
import type { Command } from 'commander';
import { openCache, setCacheStore } from '../cache/store.js';
import { pack, type PackedFile } from '../pack.js';
import { TokenCounter } from '../tokens/index.js';
import { makeColors, shouldColor, type Colors } from './colors.js';
import { formatNumber, formatPercent } from './format.js';
import type { CliIO } from './pack-command.js';

interface DirNode {
  name: string;
  tokens: number;
  raw: number;
  files: number;
  children: Map<string, DirNode>;
  file?: PackedFile;
}

function node(name: string): DirNode {
  return { name, tokens: 0, raw: 0, files: 0, children: new Map() };
}

/** Compact token count: 950, 12.3k, 1.2M. */
function short(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function render(root: DirNode, c: Colors, depth: number, minShare: number): string[] {
  const lines: string[] = [];
  const total = root.tokens || 1;
  const visit = (dir: DirNode, prefix: string, level: number) => {
    const entries = [...dir.children.values()].sort((a, b) => b.tokens - a.tokens || (a.name < b.name ? -1 : 1));
    const shown = entries.filter((e) => e.tokens / total >= minShare);
    const hidden = entries.length - shown.length;
    shown.forEach((e, i) => {
      const last = i === shown.length - 1 && hidden === 0;
      const isDir = !e.file;
      const saved = e.raw > e.tokens ? c.green(` −${formatPercent(1 - e.tokens / e.raw)}`) : '';
      const share = c.dim(` ${formatPercent(e.tokens / total)}`);
      const label = isDir ? c.bold(`${e.name}/`) : e.name;
      const count = isDir ? c.dim(` (${e.files} file${e.files === 1 ? '' : 's'})`) : '';
      lines.push(`${prefix}${last ? '└── ' : '├── '}${label} ${c.cyan(short(e.tokens))}${share}${saved}${count}`);
      if (isDir && level < depth) visit(e, `${prefix}${last ? '    ' : '│   '}`, level + 1);
    });
    if (hidden) lines.push(`${prefix}└── ${c.dim(`… ${hidden} more under ${formatPercent(minShare)} each`)}`);
  };
  visit(root, '', 1);
  return lines;
}

/** `astpack tree [directory]`: where the tokens are, per directory. */
export async function treeCommand(directory: string, command: Command, io: CliIO): Promise<number> {
  const opts = command.opts<{ depth: number; min: number; full?: boolean; outline?: boolean; color: boolean }>();
  const c = makeColors(opts.color && shouldColor(io.stdout));
  const counter = new TokenCounter();
  const root = resolve(io.cwd, directory);
  const cache = openCache(root);
  setCacheStore(cache);
  try {
    const result = await pack(root, { mode: opts.full ? 'full' : opts.outline ? 'outline' : 'skeleton' });
    const tree = node('.');
    for (const file of result.files) {
      const tokens = counter.count(file.content);
      const raw = file.content === file.original ? tokens : counter.count(file.original);
      const parts = file.path.split('/');
      let dir = tree;
      tree.tokens += tokens;
      tree.raw += raw;
      tree.files++;
      for (const part of parts.slice(0, -1)) {
        let next = dir.children.get(part);
        if (!next) dir.children.set(part, (next = node(part)));
        next.tokens += tokens;
        next.raw += raw;
        next.files++;
        dir = next;
      }
      dir.children.set(parts.at(-1)!, { ...node(parts.at(-1)!), tokens, raw, files: 1, file });
    }
    const mode = opts.full ? 'full' : opts.outline ? 'outline' : 'skeleton';
    io.stdout.write(
      `${c.bold(`${formatNumber(tree.tokens)} tokens`)} ${c.dim(`(${mode}; ${formatNumber(tree.raw)} raw, ${tree.files} files)`)}\n`,
    );
    io.stdout.write(`${render(tree, c, opts.depth, opts.min / 100).join('\n')}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(`${c.red('error:')} ${(error as Error).message}\n`);
    return 1;
  } finally {
    cache?.save();
    setCacheStore(undefined);
    counter.free();
  }
}
