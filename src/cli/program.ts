import { Command, InvalidArgumentError, Option } from 'commander';
import { OUTPUT_FORMATS } from '../output/index.js';
import { MODELS } from '../tokens/index.js';
import { VERSION } from '../version.js';
import { parsePositiveInt, parseSize, parseTokenCount } from './format.js';
import { initCommand } from './init-command.js';
import { packCommand, type CliIO } from './pack-command.js';

export type { CliIO } from './pack-command.js';

const collect = (value: string, previous: string[] = []) => [...previous, value];
const collectList = (value: string, previous: string[] = []) => [
  ...previous,
  ...value.split(',').map((s) => s.trim()).filter(Boolean),
];

function wrapParser<T>(fn: (v: string) => T) {
  return (value: string): T => {
    try {
      return fn(value);
    } catch (error) {
      throw new InvalidArgumentError((error as Error).message);
    }
  };
}

export function buildProgram(io: CliIO, setExit: (code: number) => void): Command {
  const program = new Command('astpack');
  program
    .description('Pack a codebase into an LLM-ready prompt, stripping function bodies with Tree-sitter.')
    .version(VERSION, '-v, --version')
    .argument('[directory]', 'project root to pack', '.')
    .option('-o, --output <file>', 'output file (default: astpack-output.<ext>)')
    .option('--stdout', 'write the packed document to stdout instead of a file')
    .addOption(new Option('-f, --format <format>', 'output format').choices(OUTPUT_FORMATS as string[]).default('markdown'))
    .option('-s, --skeleton', 'strip function bodies from every supported file (default)')
    .option('--full', 'include raw source without AST transformation')
    .option('--outline', 'list only declarations and signatures (one line each) outside focused files')
    .option('--focus <path>', 'keep a file, directory or glob as full source; skeletonize the rest (repeatable)', collect)
    .option('-c, --clipboard', 'copy the packed document to the clipboard')
    .option('-i, --ignore <patterns>', 'extra gitignore-style patterns to exclude (repeatable, comma-separated)', collectList)
    .option('--include <patterns>', 'only include files matching these patterns (repeatable, comma-separated)', collectList)
    .option('--no-gitignore', 'do not read .gitignore files')
    .option('--no-packignore', 'do not read .packignore / .astpackignore files')
    .option('--no-default-ignores', 'disable built-in excludes (node_modules, lockfiles, binaries, secrets...)')
    .option('--max-file-size <size>', 'skip files larger than this (e.g. 500kb, 2mb; 0 = no limit)', wrapParser(parseSize))
    .option('--fallback-lines <n>', 'max lines kept from unsupported files in skeleton mode', wrapParser(parsePositiveInt))
    .option('--fallback-chars <n>', 'max characters kept from unsupported files in skeleton mode', wrapParser(parsePositiveInt))
    .option('--placeholder <text>', 'marker text for stripped bodies (default "...")')
    .addOption(
      new Option('--comments <mode>', 'comments to keep outside focused files: all, docs (documentation only) or none')
        .choices(['all', 'docs', 'none'])
        .default('all'),
    )
    .option(
      '--max-tokens <n>',
      'fit the output into a token budget (e.g. 100k) by progressively compressing and omitting files',
      wrapParser(parseTokenCount),
    )
    .option(
      '--split-tokens <n>',
      'split the output into several files of at most n tokens each (e.g. 32k), cutting between files',
      wrapParser(parseTokenCount),
    )
    .option('--no-tree', 'omit the directory tree')
    .option('--deps', 'include the internal import graph (which file imports which)')
    .option('--instructions <text>', 'instructions placed at the top of the document (prefix with @ to read a file)')
    .option('--follow-symlinks', 'follow symbolic links')
    .option('--no-redact', 'do not mask likely secrets (API keys, tokens, private keys, passwords)')
    .option('--config <file>', 'config file (default: astpack.config.json in the directory or cwd)')
    .option('--no-config', 'ignore config files')
    .option('--changed [ref]', 'focus files changed vs a git ref (default HEAD: uncommitted and untracked changes)')
    .option('--diff [ref]', 'include the git diff vs a ref (default: the --changed ref, or HEAD)')
    .option('--remote <repo>', 'pack a remote repository (owner/repo, URL, optionally #branch) via a shallow clone')
    .option(
      '--models <ids>',
      `models to price in the summary (comma-separated; available: ${MODELS.map((m) => m.id).join(', ')})`,
      collectList,
    )
    .option('--top <n>', 'number of largest files to list in the summary', wrapParser(parsePositiveInt), 5)
    .option('-q, --quiet', 'do not print the summary')
    .option('--dry-run', 'compute everything and print the summary without writing the document (or copying it)')
    .option('-w, --watch', 'keep running and re-pack whenever a file changes')
    .option('--stats-json <file>', 'also write the summary statistics as JSON (for CI)')
    .option('--no-color', 'disable coloured output')
    .addHelpText(
      'after',
      `
Examples:
  $ npx astpack                          pack the current directory in skeleton mode
  $ npx astpack --focus src/auth -c      full source for src/auth, skeleton elsewhere, copy to clipboard
  $ npx astpack --full --include "*.py"  raw Python sources only
  $ npx astpack -f xml --stdout | llm    pipe XML output into another tool`,
    );
  program.action(async (directory: string | undefined, _opts, command: Command) => {
    setExit(await packCommand(directory ?? '.', command, io));
  });

  program
    .command('init')
    .description('create astpack.config.json and .packignore')
    .argument('[directory]', 'project root', '.')
    .option('--force', 'overwrite an existing config file')
    .action(async (directory: string, options: { force?: boolean }) => {
      setExit(await initCommand(directory, options, io));
    });

  program
    .command('mcp')
    .description('run a Model Context Protocol server over stdio (tools: pack_codebase, estimate_tokens, skeleton_file)')
    .argument('[roots...]', 'directories the tools may read (default: the current directory)')
    .action(async (roots: string[]) => {
      const { AstpackMcpServer, serveStdio } = await import('../mcp/server.js');
      const { resolve } = await import('node:path');
      const allowed = (roots.length ? roots : ['.']).map((r) => resolve(io.cwd, r));
      const server = new AstpackMcpServer({ roots: allowed, cwd: allowed[0], log: (m) => io.stderr.write(`${m}\n`) });
      io.stderr.write(`astpack MCP server ${VERSION} ready (roots: ${allowed.join(', ')})\n`);
      await serveStdio(server);
      setExit(0);
    });

  return program;
}


/** Run the CLI. Returns the process exit code. */
export async function run(argv: readonly string[], io: CliIO = { stdout: process.stdout, stderr: process.stderr, cwd: process.cwd() }): Promise<number> {
  let exitCode = 0;
  const program = buildProgram(io, (code) => {
    exitCode = code;
  });
  program.exitOverride();
  program.configureOutput({
    writeOut: (s) => io.stdout.write(s),
    writeErr: (s) => io.stderr.write(s),
  });
  try {
    await program.parseAsync(argv as string[], { from: 'user' });
  } catch (error) {
    const code = (error as { exitCode?: number }).exitCode;
    return typeof code === 'number' ? code : 1;
  }
  return exitCode;
}
