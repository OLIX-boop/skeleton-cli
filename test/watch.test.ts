import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { makeColors } from '../src/cli/colors.js';
import { watchLoop, type WatchReport } from '../src/cli/pack-command.js';
import { run } from '../src/cli/program.js';
import { makeTree } from './fixtures.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

class Capture extends Writable {
  data = '';
  override _write(chunk: Buffer, _e: string, cb: () => void) {
    this.data += chunk.toString();
    cb();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check: () => boolean, timeout = 5000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error('timed out');
    await sleep(25);
  }
}

describe('watchLoop', () => {
  it('re-runs after changes, ignoring its own outputs and .git', async () => {
    const t = await makeTree({ 'a.ts': 'export const a = 1;\n', '.git/HEAD': 'x' });
    cleanups.push(t.cleanup);
    const stderr = new Capture();
    const controller = new AbortController();
    let runs = 0;
    const out = join(t.root, 'out.md');
    const done = watchLoop({
      root: t.root,
      outputs: [out],
      rerun: async (): Promise<WatchReport> => {
        runs++;
        return { files: 1, tokens: 10, savedRatio: 0.5, destination: 'Wrote out.md', outputs: [out] };
      },
      io: { stdout: new Capture() as unknown as NodeJS.WriteStream, stderr: stderr as unknown as NodeJS.WriteStream, cwd: t.root },
      colors: makeColors(false),
      signal: controller.signal,
      debounceMs: 50,
    });
    await sleep(100); // let the watcher start

    await writeFile(out, 'generated');
    await writeFile(join(t.root, 'out.part2.md'), 'generated');
    await writeFile(join(t.root, '.git/HEAD'), 'y');
    await sleep(300);
    expect(runs).toBe(0);

    await writeFile(join(t.root, 'a.ts'), 'export const a = 2;\n');
    await waitFor(() => runs === 1);
    // Rapid edits are debounced into one rebuild.
    await writeFile(join(t.root, 'b.ts'), '1');
    await writeFile(join(t.root, 'b.ts'), '2');
    await waitFor(() => runs === 2);
    await sleep(200);
    expect(runs).toBe(2);
    expect(stderr.data).toContain('Watching');
    expect(stderr.data).toMatch(/↻ .* 1 files · 10 tokens \(−50%\) → Wrote out\.md/);

    controller.abort();
    await done;
  });

  it('rejects --watch with --stdout', async () => {
    const t = await makeTree({ 'a.ts': '' });
    cleanups.push(t.cleanup);
    const stderr = new Capture();
    const code = await run(['--watch', '--stdout'], {
      stdout: new Capture() as unknown as NodeJS.WriteStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
      cwd: t.root,
    });
    expect(code).toBe(1);
    expect(stderr.data).toContain('--watch writes a file');
  });
});
