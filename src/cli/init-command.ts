import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { CONFIG_FILES, defaultConfig } from '../config.js';
import type { CliIO } from './pack-command.js';

const PACKIGNORE_TEMPLATE = `# Files and directories astpack should skip (gitignore syntax).
# .gitignore rules and built-in excludes (node_modules, lockfiles, binaries, secrets) already apply.

# Generated code
# src/generated/

# Large fixtures
# test/fixtures/
`;

/** `astpack init [directory]`: write a starter config and .packignore. */
export async function initCommand(directory: string, options: { force?: boolean }, io: CliIO): Promise<number> {
  const root = resolve(io.cwd, directory);
  const written: string[] = [];
  const configPath = join(root, CONFIG_FILES[0]);
  const existing = CONFIG_FILES.map((f) => join(root, f)).find((p) => existsSync(p));
  if (existing && !options.force) {
    io.stderr.write(`error: ${relative(io.cwd, existing) || existing} already exists (use --force to overwrite)\n`);
    return 1;
  }
  await writeFile(configPath, `${JSON.stringify(defaultConfig(), null, 2)}\n`);
  written.push(configPath);
  const packignore = join(root, '.packignore');
  if (!existsSync(packignore)) {
    await writeFile(packignore, PACKIGNORE_TEMPLATE);
    written.push(packignore);
  }
  for (const file of written) io.stdout.write(`Created ${relative(io.cwd, file) || file}\n`);
  return 0;
}
