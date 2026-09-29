import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli/program.js';
import { configJsonSchema, loadConfig, validateConfig } from '../src/config.js';
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

async function cli(args: string[], cwd: string) {
  const stdout = new Capture();
  const stderr = new Capture();
  const code = await run(args, { stdout: stdout as unknown as NodeJS.WriteStream, stderr: stderr as unknown as NodeJS.WriteStream, cwd });
  return { code, stdout: stdout.data, stderr: stderr.data };
}

async function project(files: Record<string, string> = {}) {
  const t = await makeTree({
    'src/a.ts': '// note\nexport function a() {\n  return 1;\n}\n',
    'src/b.ts': 'export function b() {\n  return 2;\n}\n',
    'notes.md': '# Notes\n',
    ...files,
  });
  cleanups.push(t.cleanup);
  return t.root;
}

describe('validateConfig', () => {
  it('accepts valid configs and warns about unknown keys', () => {
    const { config, warnings } = validateConfig({ $schema: 'x', format: 'xml', focus: ['src'], maxTokens: '10k', surprise: 1 });
    expect(config).toEqual({ format: 'xml', focus: ['src'], maxTokens: '10k' });
    expect(warnings).toEqual(['unknown config key "surprise"']);
  });

  it.each([
    [{ format: 'yaml' }, /"format" must be one of markdown, json, xml/],
    [{ focus: 'src' }, /"focus" must be an array of strings/],
    [{ top: -1 }, /"top" must be a non-negative number/],
    [{ tree: 'no' }, /"tree" must be a boolean/],
    [[], /must be a JSON object/],
  ])('rejects %j', (raw, message) => {
    expect(() => validateConfig(raw)).toThrow(message);
  });
});

describe('loadConfig', () => {
  it('resolves paths relative to the config file', async () => {
    const root = await project({
      'astpack.config.json': JSON.stringify({ output: 'out/pack.md', focus: ['src/a.ts', '**/*.md'], instructions: '@task.txt' }),
    });
    const { config } = await loadConfig(join(root, 'astpack.config.json'));
    expect(config.output).toBe(join(root, 'out/pack.md'));
    // focus names files in the packed project; it is resolved later (see pack-command).
    expect(config.focus).toEqual(['src/a.ts', '**/*.md']);
    expect(config.instructions).toBe(`@${join(root, 'task.txt')}`);
  });

  it('reports malformed JSON with the file name', async () => {
    const root = await project({ 'astpack.config.json': '{ nope' });
    await expect(loadConfig(join(root, 'astpack.config.json'))).rejects.toThrow(/astpack\.config\.json/);
  });
});

describe('config in the CLI', () => {
  it('applies config values', async () => {
    const root = await project({
      'astpack.config.json': JSON.stringify({ format: 'json', stdout: true, comments: 'none', ignore: ['notes.md'], focus: ['src/b.ts'] }),
    });
    const { code, stdout } = await cli(['-q'], root);
    expect(code).toBe(0);
    const doc = JSON.parse(stdout);
    expect(doc.files.map((f: { path: string }) => f.path)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(doc.files[0].content).toBe('export function a() { /* ... */ }\n');
    expect(doc.files[1]).toMatchObject({ focused: true, content: 'export function b() {\n  return 2;\n}\n' });
  });

  it('lets CLI flags override config values and merges ignore lists', async () => {
    const root = await project({ '.astpackrc.json': JSON.stringify({ format: 'json', stdout: true, mode: 'full', ignore: ['notes.md'] }) });
    const { stdout } = await cli(['-q', '-f', 'markdown', '--skeleton', '-i', 'src/b.ts'], root);
    expect(stdout).toContain('# ');
    expect(stdout).toContain('export function a() { /* ... */ }');
    expect(stdout).not.toContain('src/b.ts');
    expect(stdout).not.toContain('notes.md');
  });

  it('supports --config and --no-config', async () => {
    const root = await project({
      'astpack.config.json': JSON.stringify({ stdout: true, format: 'json' }),
      'alt.json': JSON.stringify({ stdout: true, format: 'xml' }),
    });
    expect((await cli(['-q', '--config', 'alt.json'], root)).stdout).toMatch(/^<project/);
    const none = await cli(['-q', '--no-config', '--stdout'], root);
    expect(none.stdout).toMatch(/^# /);
  });

  it('fails clearly on an invalid config', async () => {
    const root = await project({ 'astpack.config.json': JSON.stringify({ comments: 'some' }) });
    const { code, stderr } = await cli(['-q', '--stdout'], root);
    expect(code).toBe(1);
    expect(stderr).toContain('"comments" must be one of all, docs, none');
  });

  it('parses size and token strings from config', async () => {
    const root = await project({ 'astpack.config.json': JSON.stringify({ stdout: true, maxFileSize: '1kb', maxTokens: '1k' }) });
    await writeFile(join(root, 'big.txt'), 'x'.repeat(5000));
    const { code, stdout, stderr } = await cli(['--no-color'], root);
    expect(code).toBe(0);
    expect(stdout).not.toContain('big.txt');
    expect(stderr).toMatch(/Token budget\s+│ [\d,]+ \/ 1,000/);
  });
});

describe('astpack init', () => {
  it('creates a config and a .packignore, refusing to overwrite without --force', async () => {
    const root = await project();
    const first = await cli(['init'], root);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain('Created astpack.config.json');
    expect(first.stdout).toContain('Created .packignore');
    const config = JSON.parse(await readFile(join(root, 'astpack.config.json'), 'utf8'));
    expect(validateConfig(config).warnings).toEqual([]);
    const again = await cli(['init'], root);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain('already exists');
    expect((await cli(['init', '--force'], root)).code).toBe(0);
  });
});

describe('schema.json', () => {
  it('matches the config definition (run `npm run schema` to update)', async () => {
    const onDisk = JSON.parse(await readFile(new URL('../schema.json', import.meta.url), 'utf8'));
    expect(onDisk).toEqual(configJsonSchema());
  });
});

describe('presets', () => {
  it('explain: outline + deps + instructions', async () => {
    const root = await project({ 'src/c.ts': "import { a } from './a';\nexport const c = a;\n" });
    const { code, stdout } = await cli(['--stdout', '-q', '--preset', 'explain'], root);
    expect(code).toBe(0);
    expect(stdout).toContain('## Instructions\n\nExplain the architecture');
    expect(stdout).toContain('[outline]');
    expect(stdout).toContain('src/c.ts -> src/a.ts');
  });

  it('lets explicit flags and config values override the preset', async () => {
    const root = await project({ 'astpack.config.json': JSON.stringify({ deps: false }) });
    const { stdout } = await cli(['--stdout', '-q', '--preset', 'explain', '--skeleton', '--instructions', 'Mine.'], root);
    expect(stdout).toContain('## Instructions\n\nMine.');
    expect(stdout).not.toContain('[outline]');
    expect(stdout).not.toContain('## Dependencies');
  });

  it('does not accept claudeTokens from a config file (it would upload the document)', () => {
    expect(validateConfig({ claudeTokens: true }).warnings).toEqual(['unknown config key "claudeTokens"']);
  });

  it('rejects unknown presets', async () => {
    const root = await project();
    expect((await cli(['--preset', 'nope'], root)).code).not.toBe(0);
  });
});
