import { writeFile } from 'node:fs/promises';
import { basename, relative, resolve } from 'node:path';
import { Command, InvalidArgumentError, Option } from 'commander';
import { pack, type PackOptions } from '../pack.js';
import { OUTPUT_EXTENSIONS, OUTPUT_FORMATS, render, type OutputFormat } from '../output/index.js';
import { computeStats, DEFAULT_MODELS, findModel, MODELS } from '../tokens/index.js';
import { VERSION } from '../version.js';
import { copyToClipboard } from './clipboard.js';
import { makeColors, shouldColor } from './colors.js';
import { parsePositiveInt, parseSize } from './format.js';
import { renderSummary } from './summary.js';
import { toPosix } from '../walker/rules.js';
import type { CommentMode } from '../languages/types.js';

export interface CliIO {
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
  cwd: string;
}

interface RawOptions {
  output?: string;
  stdout?: boolean;
  format: OutputFormat;
  skeleton?: boolean;
  full?: boolean;
  focus: string[];
  clipboard?: boolean;
  ignore: string[];
  include: string[];
  gitignore: boolean;
  packignore: boolean;
  defaultIgnores: boolean;
  maxFileSize?: number;
  fallbackLines?: number;
  fallbackChars?: number;
  placeholder?: string;
  comments: CommentMode;
  tree: boolean;
  instructions?: string;
  followSymlinks?: boolean;
  models: string[];
  top: number;
  quiet?: boolean;
  color: boolean;
}

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

export function buildProgram(): Command {
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
    .option('--no-tree', 'omit the directory tree')
    .option('--instructions <text>', 'instructions placed at the top of the document (prefix with @ to read a file)')
    .option('--follow-symlinks', 'follow symbolic links')
    .option(
      '--models <ids>',
      `models to price in the summary (comma-separated; available: ${MODELS.map((m) => m.id).join(', ')})`,
      collectList,
    )
    .option('--top <n>', 'number of largest files to list in the summary', wrapParser(parsePositiveInt), 5)
    .option('-q, --quiet', 'do not print the summary')
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
  return program;
}

async function readInstructions(value: string | undefined, cwd: string): Promise<string | undefined> {
  if (!value) return undefined;
  if (!value.startsWith('@')) return value;
  const { readFile } = await import('node:fs/promises');
  return readFile(resolve(cwd, value.slice(1)), 'utf8');
}

/** Run the CLI. Returns the process exit code. */
export async function run(argv: readonly string[], io: CliIO = { stdout: process.stdout, stderr: process.stderr, cwd: process.cwd() }): Promise<number> {
  const program = buildProgram();
  program.exitOverride();
  program.configureOutput({
    writeOut: (s) => io.stdout.write(s),
    writeErr: (s) => io.stderr.write(s),
  });

  try {
    program.parse(argv as string[], { from: 'user' });
  } catch (error) {
    const code = (error as { exitCode?: number }).exitCode;
    return typeof code === 'number' ? code : 1;
  }

  const parsed = program.opts<Partial<RawOptions>>();
  const opts = { ...parsed, focus: parsed.focus ?? [], ignore: parsed.ignore ?? [], include: parsed.include ?? [], models: parsed.models ?? [] } as RawOptions;
  const directory = program.args[0] ?? '.';
  const summaryStream = opts.stdout ? io.stderr : io.stdout;
  const colors = makeColors(opts.color && shouldColor(summaryStream));
  const errColors = makeColors(opts.color && shouldColor(io.stderr));

  try {
    if (opts.skeleton && opts.full) throw new Error('--skeleton and --full are mutually exclusive');
    const unknownModels = opts.models.filter((m) => !findModel(m));
    if (unknownModels.length) {
      throw new Error(`Unknown model(s): ${unknownModels.join(', ')}. Available: ${MODELS.map((m) => m.id).join(', ')}`);
    }

    const root = resolve(io.cwd, directory);
    const outputPath = opts.stdout ? undefined : resolve(io.cwd, opts.output ?? `astpack-output.${OUTPUT_EXTENSIONS[opts.format]}`);
    const ignore = [...opts.ignore];
    // Never pack our own output file.
    if (outputPath) {
      const rel = toPosix(relative(root, outputPath));
      if (rel && !rel.startsWith('..')) ignore.push(`/${rel}`);
    }

    const showProgress = !opts.quiet && !!io.stderr.isTTY;
    const packOptions: PackOptions = {
      mode: opts.full ? 'full' : 'skeleton',
      focus: opts.focus,
      cwd: io.cwd,
      placeholder: opts.placeholder,
      comments: opts.comments,
      fallback: {
        ...(opts.fallbackLines !== undefined ? { maxLines: opts.fallbackLines } : {}),
        ...(opts.fallbackChars !== undefined ? { maxChars: opts.fallbackChars } : {}),
      },
      gitignore: opts.gitignore,
      packignore: opts.packignore,
      defaultIgnores: opts.defaultIgnores,
      ignore,
      include: opts.include,
      maxFileSize: opts.maxFileSize,
      followSymlinks: opts.followSymlinks,
      onProgress: showProgress
        ? (done, total) => {
            if (done === total || done % 25 === 0) io.stderr.write(`\r${errColors.dim(`Packing ${done}/${total} files…`)}`);
          }
        : undefined,
    };

    const result = await pack(root, packOptions);
    if (showProgress) io.stderr.write('\r\u001b[K');
    for (const target of result.focusOutsideRoot) {
      io.stderr.write(errColors.yellow(`warning: --focus ${target} is outside ${root}\n`));
    }
    if (result.files.length === 0) {
      io.stderr.write(errColors.yellow(`warning: no files included from ${root} (check your ignore/include rules)\n`));
    }
    if (opts.focus.length && !result.files.some((f) => f.focused)) {
      io.stderr.write(errColors.yellow(`warning: no files matched --focus ${opts.focus.join(', ')}\n`));
    }

    const document = render(opts.format, result, {
      projectName: basename(root),
      tree: opts.tree,
      instructions: await readInstructions(opts.instructions, io.cwd),
      focus: opts.focus,
      version: VERSION,
    });

    const destinations: string[] = [];
    if (outputPath) {
      await writeFile(outputPath, document);
      const shown = toPosix(relative(io.cwd, outputPath));
      destinations.push(`Wrote ${shown && !shown.startsWith('..') ? shown : outputPath}`);
    } else {
      io.stdout.write(document);
    }
    if (opts.clipboard) {
      await copyToClipboard(document);
      destinations.push('copied to clipboard');
    }

    if (!opts.quiet) {
      const stats = computeStats(result, document, { models: opts.models.length ? opts.models : [...DEFAULT_MODELS] });
      const label = destinations.length ? destinations.join(', ') : 'Wrote to stdout';
      summaryStream.write(`${renderSummary(stats, { colors, top: opts.top, outputLabel: label, mode: result.mode })}\n`);
    }
    return 0;
  } catch (error) {
    io.stderr.write(`${errColors.red('error:')} ${(error as Error).message}\n`);
    return 1;
  }
}
