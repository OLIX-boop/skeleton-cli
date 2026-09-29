import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { workerCount } from '../src/parallel/pool.js';
import { makeTree } from './fixtures.js';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
// Worker threads run the compiled worker script, so this needs `npm run build` first (CI does).
const built = existsSync(CLI) && existsSync(fileURLToPath(new URL('../dist/parallel/worker.js', import.meta.url)));

describe('workerCount', () => {
  it('honours ASTPACK_WORKERS and otherwise leaves a core free', () => {
    expect(workerCount({ ASTPACK_WORKERS: '0' })).toBe(0);
    expect(workerCount({ ASTPACK_WORKERS: '3' })).toBe(3);
    expect(workerCount({ ASTPACK_WORKERS: '1' })).toBe(1);
    expect(workerCount({ ASTPACK_WORKERS: 'many' })).toBe(0);
    expect(workerCount({})).toBeLessThanOrEqual(6);
  });
});

describe.skipIf(!built)('parallel packing (built CLI)', { timeout: 60_000 }, () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it('produces the same document and summary with and without worker threads', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 260; i++) {
      files[`src/m${i}.ts`] = `import { m${(i + 1) % 260} } from './m${(i + 1) % 260}';\n/** Module ${i}. */\nexport function m${i}(x: number): number {\n  return x * ${i};\n}\n`;
      if (i % 20 === 0) files[`py/p${i}.py`] = `def p${i}(x):\n    """Doc."""\n    return x + ${i}\n`;
    }
    files['README.md'] = '# Demo\n';
    // Mapped by the config file: workers must see the mapping too.
    files['lib/legacy.inc'] = '<?php\nfunction legacy($x) {\n    return $x * 2;\n}\n';
    files['astpack.config.json'] = JSON.stringify({ extensions: { '.inc': 'php' } });
    const t = await makeTree(files);
    cleanup = t.cleanup;
    const pack = async (workers: string) => {
      const env = { ...process.env, ASTPACK_WORKERS: workers, ASTPACK_NO_CACHE: '1', NO_COLOR: '1' };
      const { stdout } = await run(process.execPath, [CLI, t.root, '--stdout', '--max-tokens', '6000'], { env, maxBuffer: 64 * 1024 * 1024 });
      return stdout;
    };
    const [sequential, parallel] = await Promise.all([pack('0'), pack('2')]);
    expect(sequential).toContain('export function m7(x: number): number');
    expect(parallel).toBe(sequential);
    // Parsed as PHP (the budget may outline it), not included as unsupported text.
    expect(parallel).toMatch(/### `lib\/legacy\.inc`[^\n]*\n\n```(php|text)\n(<\?php\n)?function legacy\(\$x\)/);
    expect(parallel).not.toContain('return $x * 2;');
  });
});
