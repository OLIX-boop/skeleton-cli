import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli/program.js';
import { render } from '../src/output/index.js';
import { pack } from '../src/pack.js';
import { partPath, splitPack } from '../src/split.js';
import { TokenCounter } from '../src/tokens/index.js';
import { makeTree } from './fixtures.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

function file(name: string, lines: number) {
  return Array.from({ length: lines }, (_, i) => `export const ${name}${i} = "${'value '.repeat(8)}${i}";`).join('\n') + '\n';
}

async function project() {
  const t = await makeTree({
    'a.ts': file('a', 40),
    'b.ts': file('b', 40),
    'c.ts': file('c', 40),
    'd.ts': file('d', 40),
    'huge.ts': file('h', 300),
  });
  cleanups.push(t.cleanup);
  return t.root;
}

const count = (s: string) => {
  const c = new TokenCounter();
  try {
    return c.count(s);
  } finally {
    c.free();
  }
};

describe('splitPack', () => {
  it('keeps every part within the limit except oversized single files', async () => {
    const root = await project();
    const result = await pack(root, { mode: 'full' });
    const report = splitPack(result, {
      maxTokens: 1500,
      render: (r, part) => render('markdown', r, { projectName: 'p', part }),
    });
    expect(report.oversized).toEqual(['huge.ts']);
    expect(report.parts.length).toBeGreaterThan(2);
    // Order is preserved and nothing is lost or duplicated.
    expect(report.parts.flatMap((p) => p.files.map((f) => f.path))).toEqual(result.files.map((f) => f.path));
    for (const part of report.parts) {
      expect(part.tokens).toBe(count(part.document));
      if (!part.files.some((f) => f.path === 'huge.ts')) expect(part.tokens).toBeLessThanOrEqual(1500);
      expect(part.document).toContain(`(part ${part.index} of ${report.parts.length})`);
    }
    expect(report.parts[0]!.document).toContain('## Directory structure');
    expect(report.parts[1]!.document).not.toContain('## Directory structure');
    expect(report.parts[1]!.document).toContain('the directory structure is in part 1');
  });

  it('judges oversized files against the overhead of the part they land in', async () => {
    const root = await project();
    const result = await pack(root, { mode: 'full', ignore: ['huge.ts'] });
    const instructions = 'Context for the task. '.repeat(250); // a large part-1-only header
    const report = splitPack(result, {
      maxTokens: 1700,
      render: (r, part) => render('markdown', r, { projectName: 'p', part, instructions }),
    });
    // Each file fits in a later part; only part 1 is too crowded to hold one.
    expect(report.oversized).toEqual([]);
    expect(report.parts[0]!.files).toEqual([]);
    expect(report.parts[0]!.document).toContain('## Directory structure');
  });

  it('returns a single part when everything fits', async () => {
    const root = await project();
    const result = await pack(root, { mode: 'full' });
    const report = splitPack(result, { maxTokens: 1_000_000, render: (r, part) => render('xml', r, { projectName: 'p', part }) });
    expect(report.parts).toHaveLength(1);
    expect(report.parts[0]!.document).toContain('part="1" parts="1"');
  });
});

describe('partPath', () => {
  it.each([
    ['out.md', 1, 'out.part1.md'],
    ['dir/pack.json', 3, 'dir/pack.part3.json'],
    ['noext', 2, 'noext.part2'],
    ['.hidden/file', 1, '.hidden/file.part1'],
  ])('%s #%i -> %s', (path, i, expected) => {
    expect(partPath(path, i)).toBe(expected);
  });
});

class Capture extends Writable {
  data = '';
  override _write(chunk: Buffer, _e: string, cb: () => void) {
    this.data += chunk.toString();
    cb();
  }
}

describe('--split-tokens', () => {
  it('writes numbered part files into a new directory and excludes them next time', async () => {
    const root = await project();
    const io = () => ({ stdout: new Capture() as unknown as NodeJS.WriteStream, stderr: new Capture() as unknown as NodeJS.WriteStream, cwd: root });
    expect(await run(['-q', '--full', '--split-tokens', '1.5k', '-o', 'out/pack.md'], io())).toBe(0);
    const files = (await readdir(join(root, 'out'))).sort();
    expect(files[0]).toBe('pack.part1.md');
    expect(files.length).toBeGreaterThan(2);
    const second = io();
    expect(await run(['-q', '--full', '--split-tokens', '1.5k', '-o', 'out/pack.md'], second)).toBe(0);
    const part1 = await readFile(join(root, 'out/pack.part1.md'), 'utf8');
    expect(part1).not.toContain('pack.part');
    const bad = io();
    expect(await run(['--split-tokens', '1k', '--stdout'], bad)).toBe(1);
  });
});
