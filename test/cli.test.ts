import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli/program.js';
import { VERSION } from '../src/version.js';
import { makeTree } from './fixtures.js';

class Capture extends Writable {
  data = '';
  isTTY = false;
  override _write(chunk: Buffer, _enc: string, cb: () => void) {
    this.data += chunk.toString();
    cb();
  }
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

async function project() {
  const t = await makeTree({
    'README.md': '# Demo\n',
    'src/auth/login.ts': 'export function login(u: string): boolean {\n  return u === "admin";\n}\n',
    'src/db.py': 'def connect(url: str):\n    """Open a connection."""\n    return open(url)\n',
    'yarn.lock': 'x',
  });
  cleanups.push(t.cleanup);
  return t.root;
}

async function cli(args: string[], cwd: string) {
  const stdout = new Capture();
  const stderr = new Capture();
  const code = await run(args, { stdout: stdout as unknown as NodeJS.WriteStream, stderr: stderr as unknown as NodeJS.WriteStream, cwd });
  return { code, stdout: stdout.data, stderr: stderr.data };
}

describe('cli', () => {
  it('prints the version', async () => {
    const { code, stdout } = await cli(['--version'], '.');
    expect(code).toBe(0);
    expect(stdout.trim()).toBe(VERSION);
  });

  it('writes skeleton markdown to stdout with the summary on stderr', async () => {
    const root = await project();
    const { code, stdout, stderr } = await cli(['--stdout', '--no-color'], root);
    expect(code).toBe(0);
    expect(stdout).toContain('## Directory structure');
    expect(stdout).toContain('export function login(u: string): boolean { /* ... */ }');
    expect(stdout).toContain('    """Open a connection."""\n    ...');
    expect(stdout).not.toContain('yarn.lock');
    expect(stderr).toContain('astpack summary');
    expect(stderr).toMatch(/Tokens saved\s+│ [\d.]+%/);
    expect(stderr).toContain('Claude 3.5 Sonnet');
    expect(stderr).toContain('GPT-4o');
  });

  it('writes to the default output file and never packs it on the next run', async () => {
    const root = await project();
    const first = await cli(['-q'], root);
    expect(first.code).toBe(0);
    const out = await readFile(join(root, 'astpack-output.md'), 'utf8');
    expect(out).toContain('### `src/auth/login.ts`');
    await cli(['-q'], root);
    expect(await readFile(join(root, 'astpack-output.md'), 'utf8')).toBe(out);
  });

  it('excludes a custom output file inside the root', async () => {
    const root = await project();
    await cli(['-q', '-o', 'pack.md'], root);
    expect(await readFile(join(root, 'pack.md'), 'utf8')).not.toContain('### `pack.md`');
  });

  it('supports --full', async () => {
    const root = await project();
    const { stdout } = await cli(['--stdout', '-q', '--full'], root);
    expect(stdout).toContain('return u === "admin";');
    expect(stdout).toContain('mode: full');
  });

  it('supports --focus relative to the working directory', async () => {
    const root = await project();
    const { stdout } = await cli(['--stdout', '-q', '--focus', 'src/auth'], root);
    expect(stdout).toContain('### `src/auth/login.ts` [focus]');
    expect(stdout).toContain('return u === "admin";');
    expect(stdout).toContain('def connect(url: str):\n    """Open a connection."""\n    ...');
  });

  it('warns when --focus matches nothing', async () => {
    const root = await project();
    const { stderr } = await cli(['--stdout', '-q', '--focus', 'nope', '--no-color'], root);
    expect(stderr).toContain('warning: no files matched --focus nope');
  });

  it('emits valid JSON', async () => {
    const root = await project();
    const { stdout } = await cli(['--stdout', '-q', '-f', 'json'], root);
    const doc = JSON.parse(stdout);
    expect(doc.mode).toBe('skeleton');
    expect(doc.files.map((f: { path: string }) => f.path)).toEqual(['README.md', 'src/db.py', 'src/auth/login.ts']);
    expect(doc.skipped).toEqual([{ path: 'yarn.lock', reason: 'ignored' }]);
  });

  it('emits XML', async () => {
    const root = await project();
    const { stdout } = await cli(['--stdout', '-q', '-f', 'xml', '--no-tree'], root);
    expect(stdout).toMatch(/^<project name="[^"]+" mode="skeleton" files="3">/);
    expect(stdout).toContain('<file path="src/auth/login.ts" language="typescript" strategy="skeleton">');
    expect(stdout).not.toContain('<directory_structure>');
  });

  it('applies --include and --ignore', async () => {
    const root = await project();
    const inc = JSON.parse((await cli(['--stdout', '-q', '-f', 'json', '--include', '*.ts,*.py', '-i', 'src/db.py'], root)).stdout);
    expect(inc.files.map((f: { path: string }) => f.path)).toEqual(['src/auth/login.ts']);
  });

  it('reads instructions from a file', async () => {
    const root = await project();
    await writeFile(join(root, 'task.txt'), 'Find the auth bug.');
    const { stdout } = await cli(['--stdout', '-q', '--instructions', '@task.txt', '-i', 'task.txt'], root);
    expect(stdout).toContain('## Instructions\n\nFind the auth bug.');
  });

  it('strips comments with --comments none but never in focused files', async () => {
    const root = await project();
    const { writeFile: wf } = await import('node:fs/promises');
    await wf(join(root, 'src/auth/login.ts'), '// auth\nexport function login(u: string): boolean {\n  return u === "admin"; // check\n}\n');
    await wf(join(root, 'src/util.ts'), '// helper\nexport const x = 1; // one\n');
    const { stdout } = await cli(['--stdout', '-q', '--comments', 'none', '--focus', 'src/auth'], root);
    expect(stdout).toContain('return u === "admin"; // check');
    expect(stdout).toContain('```ts\nexport const x = 1;\n```');
  });

  it('fits --max-tokens budgets', async () => {
    const root = await project();
    const body = Array.from({ length: 80 }, (_, i) => `  total += compute(${i}) * ${i};`).join('\n');
    await writeFile(join(root, 'src/big.ts'), `export function big(): number {\n  let total = 0;\n${body}\n  return total;\n}\n`);
    const { code, stdout, stderr } = await cli(['--stdout', '--no-color', '--full', '--max-tokens', '0.5k'], root);
    expect(code).toBe(0);
    expect(stderr).toMatch(/Token budget\s+│ [\d,]+ \/ 500 ✔ fits/);
    expect(stdout).toContain('{ /* ... */ }');
    const tight = await cli(['--stdout', '--no-color', '--max-tokens', '10'], root);
    expect(tight.stderr).toContain('over the 10 budget');
    expect((await cli(['--max-tokens', 'lots'], root)).stderr).toContain('Invalid token count');
  });

  it('masks secrets unless --no-redact is given', async () => {
    const root = await project();
    const token = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
    await writeFile(join(root, 'config.ts'), `export const token = "${token}";\n`);
    const masked = await cli(['--stdout', '--no-color'], root);
    expect(masked.stdout).not.toContain(token);
    expect(masked.stdout).toContain('[REDACTED:github-token]');
    expect(masked.stderr).toContain('Masked 1 likely secret in config.ts');
    const raw = await cli(['--stdout', '-q', '--no-redact'], root);
    expect(raw.stdout).toContain(token);
  });

  it('prices selected models', async () => {
    const root = await project();
    const { stderr } = await cli(['--stdout', '--no-color', '--models', 'claude-opus-5.5,gpt-4o-mini'], root);
    expect(stderr).toContain('Claude Opus 5.5');
    expect(stderr).toContain('GPT-4o mini');
    expect(stderr).not.toContain('Claude 3.5 Sonnet');
  });

  it('rejects unknown models, conflicting modes and bad sizes', async () => {
    const root = await project();
    expect((await cli(['--stdout', '--models', 'gpt-9'], root)).stderr).toContain('Unknown model(s): gpt-9');
    expect((await cli(['--stdout', '--skeleton', '--full'], root)).code).toBe(1);
    const bad = await cli(['--max-file-size', 'huge'], root);
    expect(bad.code).not.toBe(0);
    expect(bad.stderr).toContain('Invalid size');
  });

  it('fails on a missing directory', async () => {
    const root = await project();
    const { code, stderr } = await cli(['does-not-exist', '--stdout'], root);
    expect(code).toBe(1);
    expect(stderr).toContain('error:');
  });
});

describe('dry runs and machine-readable stats', () => {
  it('--dry-run writes nothing', async () => {
    const t = await makeTree({ 'a.ts': 'export function a() {\n  return 1;\n}\n' });
    cleanups.push(t.cleanup);
    const { code, stdout } = await cli(['--dry-run', '--no-color'], t.root);
    expect(code).toBe(0);
    expect(stdout).toContain('Dry run: nothing written');
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(t.root, 'astpack-output.md'))).toBe(false);
  });

  it('--stats-json writes the statistics', async () => {
    const t = await makeTree({ 'a.ts': 'export function a() {\n  return 1;\n}\n' });
    cleanups.push(t.cleanup);
    const { code } = await cli(['-q', '--stdout', '--stats-json', 'out/stats.json', '--models', 'gpt-4o'], t.root);
    expect(code).toBe(0);
    const stats = JSON.parse(await readFile(join(t.root, 'out/stats.json'), 'utf8'));
    expect(stats.files.included).toBe(1);
    expect(stats.tokens.cl100k_base.output).toBeGreaterThan(0);
    expect(stats.costs[0].model).toBe('gpt-4o');
    expect(stats.filesByTokens[0]).toMatchObject({ path: 'a.ts', strategy: 'skeleton' });
  });
});
