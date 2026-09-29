import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, relative, resolve } from 'node:path';
import type { Command } from 'commander';
import { fitToBudget, type BudgetReport } from '../budget.js';
import { findConfig, loadConfig, type AstpackConfig } from '../config.js';
import { changedFiles, cloneRemote, diffText, parseRemote } from '../git.js';
import { OUTPUT_EXTENSIONS, render } from '../output/index.js';
import { pack, type PackOptions } from '../pack.js';
import { partPath, splitPack, type SplitReport } from '../split.js';
import { redactSecrets } from '../security/secrets.js';
import { computeStats, DEFAULT_MODELS, findModel, MODELS } from '../tokens/index.js';
import { VERSION } from '../version.js';
import { toPosix } from '../walker/rules.js';
import { copyToClipboard } from './clipboard.js';
import { makeColors, shouldColor, type Colors } from './colors.js';
import { formatNumber, parseSize, parseTokenCount } from './format.js';
import type { PackCliOptions } from './options.js';
import { renderSummary } from './summary.js';

export interface CliIO {
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
  cwd: string;
}

function maybeRedact(text: string, redact: boolean): string {
  return redact ? redactSecrets(text).content : text;
}

async function readInstructions(value: string | undefined, cwd: string): Promise<string | undefined> {
  if (!value) return undefined;
  if (!value.startsWith('@')) return value;
  return readFile(resolve(cwd, value.slice(1)), 'utf8');
}

/**
 * Apply config-file values to options the user did not set on the command line.
 * `ignore`/`include` lists are merged instead of overridden.
 */
export function applyConfig(opts: PackCliOptions, config: AstpackConfig, fromCli: (key: string) => boolean): PackCliOptions {
  const next: PackCliOptions = { ...opts };
  for (const [key, value] of Object.entries(config) as [keyof AstpackConfig, unknown][]) {
    switch (key) {
      case 'mode':
        if (!fromCli('skeleton') && !fromCli('full')) next.full = value === 'full';
        break;
      case 'ignore':
      case 'include':
        next[key] = [...(value as string[]), ...opts[key]];
        break;
      case 'maxFileSize':
        if (!fromCli(key)) next.maxFileSize = typeof value === 'number' ? value : parseSize(value as string);
        break;
      case 'maxTokens':
      case 'splitTokens':
        if (!fromCli(key)) next[key] = typeof value === 'number' ? value : parseTokenCount(value as string);
        break;
      default:
        if (!fromCli(key)) (next as unknown as Record<string, unknown>)[key] = value;
    }
  }
  return next;
}

function warn(io: CliIO, c: Colors, message: string) {
  io.stderr.write(c.yellow(`warning: ${message}\n`));
}

/** The main `astpack [directory]` command. Returns the exit code. */
export async function packCommand(directory: string, command: Command, io: CliIO): Promise<number> {
  const parsed = command.opts<Partial<PackCliOptions>>();
  let opts = {
    ...parsed,
    focus: parsed.focus ?? [],
    ignore: parsed.ignore ?? [],
    include: parsed.include ?? [],
    models: parsed.models ?? [],
  } as PackCliOptions;
  const errColors = makeColors(opts.color && shouldColor(io.stderr));
  const cleanups: (() => Promise<void>)[] = [];

  try {
    let root = resolve(io.cwd, directory);
    let projectName = basename(root);

    // Config file: explicit --config, else astpack.config.json in the root or cwd.
    if (opts.config !== false) {
      const path = typeof opts.config === 'string' ? resolve(io.cwd, opts.config) : findConfig(opts.remote ? [io.cwd] : [root, io.cwd]);
      if (path) {
        const loaded = await loadConfig(path);
        for (const w of loaded.warnings) warn(io, errColors, w);
        opts = applyConfig(opts, loaded.config, (key) => command.getOptionValueSource(key) === 'cli');
      }
    }

    const summaryStream = opts.stdout ? io.stderr : io.stdout;
    const colors = makeColors(opts.color && shouldColor(summaryStream));

    if (opts.skeleton && opts.full) throw new Error('--skeleton and --full are mutually exclusive');
    if (opts.splitTokens && (opts.stdout || opts.clipboard)) throw new Error('--split-tokens writes files; it cannot be combined with --stdout or --clipboard');
    const unknownModels = opts.models.filter((m) => !findModel(m));
    if (unknownModels.length) {
      throw new Error(`Unknown model(s): ${unknownModels.join(', ')}. Available: ${MODELS.map((m) => m.id).join(', ')}`);
    }

    if (opts.remote) {
      const spec = parseRemote(opts.remote);
      if (!opts.quiet) io.stderr.write(errColors.dim(`Cloning ${spec.url}${spec.branch ? ` (${spec.branch})` : ''}…\n`));
      const clone = await cloneRemote(spec);
      cleanups.push(clone.cleanup);
      root = clone.dir;
      projectName = spec.name;
    }

    const changedRef = opts.changed === true ? 'HEAD' : opts.changed || undefined;
    const focus = [...opts.focus];
    if (changedRef) {
      const changed = await changedFiles(root, changedRef);
      if (!changed.length) warn(io, errColors, `no files changed vs ${changedRef}`);
      focus.push(...changed);
    }

    const outputPath = opts.stdout ? undefined : resolve(io.cwd, opts.output ?? `astpack-output.${OUTPUT_EXTENSIONS[opts.format]}`);
    const ignore = [...opts.ignore];
    // Never pack our own output file.
    if (outputPath) {
      const rel = toPosix(relative(root, outputPath));
      if (rel && !rel.startsWith('..')) ignore.push(`/${rel}`, `/${partPath(rel, 0).replace('.part0', '.part*')}`);
    }

    const showProgress = !opts.quiet && !!io.stderr.isTTY;
    const packOptions: PackOptions = {
      mode: opts.full ? 'full' : 'skeleton',
      focus,
      cwd: io.cwd,
      placeholder: opts.placeholder,
      comments: opts.comments,
      redact: opts.redact,
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

    let result = await pack(root, packOptions);
    if (showProgress) io.stderr.write('\r\u001b[K');
    for (const target of result.focusOutsideRoot) warn(io, errColors, `--focus ${target} is outside ${root}`);
    if (result.files.length === 0) warn(io, errColors, `no files included from ${root} (check your ignore/include rules)`);
    if (opts.focus.length && !result.files.some((f) => f.focused)) {
      warn(io, errColors, `no files matched --focus ${opts.focus.join(', ')}`);
    }

    const diffRef = opts.diff === true ? (changedRef ?? 'HEAD') : opts.diff || undefined;
    const renderOptions = {
      projectName,
      tree: opts.tree,
      instructions: await readInstructions(opts.instructions, io.cwd),
      focus: changedRef ? [...opts.focus, `changed vs ${changedRef}`] : opts.focus,
      version: VERSION,
      diff: diffRef ? { ref: diffRef, text: maybeRedact(await diffText(root, diffRef), opts.redact) } : undefined,
    };

    let document: string;
    let budget: BudgetReport | undefined;
    if (opts.maxTokens) {
      budget = await fitToBudget(result, {
        maxTokens: opts.maxTokens,
        render: (r) => render(opts.format, r, renderOptions),
        comments: opts.comments,
        placeholder: opts.placeholder,
        fallback: packOptions.fallback,
        redact: opts.redact,
      });
      result = budget.result;
      document = budget.document;
      if (!budget.fits) {
        const why = budget.focusTokens > opts.maxTokens ? ' (focused files alone exceed it)' : '';
        warn(io, errColors, `output is ${formatNumber(budget.tokens)} tokens, over the ${formatNumber(opts.maxTokens)} budget${why}`);
      }
    } else {
      document = render(opts.format, result, renderOptions);
    }

    const destinations: string[] = [];
    const display = (p: string) => {
      const shown = toPosix(relative(io.cwd, p));
      return shown && !shown.startsWith('..') ? shown : p;
    };
    let parts: SplitReport | undefined;
    if (outputPath) await mkdir(dirname(outputPath), { recursive: true });
    if (outputPath && opts.splitTokens) {
      parts = splitPack(result, {
        maxTokens: opts.splitTokens,
        render: (r, part) => render(opts.format, r, { ...renderOptions, part }),
      });
      for (const part of parts.parts) await writeFile(partPath(outputPath, part.index), part.document);
      const first = display(partPath(outputPath, 1));
      destinations.push(`Wrote ${parts.parts.length} part${parts.parts.length === 1 ? '' : 's'} (${first}${parts.parts.length > 1 ? ' …' : ''})`);
      for (const path of parts.oversized) warn(io, errColors, `${path} alone exceeds --split-tokens ${formatNumber(opts.splitTokens)}`);
    } else if (outputPath) {
      await writeFile(outputPath, document);
      destinations.push(`Wrote ${display(outputPath)}`);
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
      summaryStream.write(
        `${renderSummary(stats, { colors, top: opts.top, outputLabel: label, mode: result.mode, budget, parts: parts?.parts.map((p) => p.tokens) })}\n`,
      );
    }
    return 0;
  } catch (error) {
    io.stderr.write(`${errColors.red('error:')} ${(error as Error).message}\n`);
    return 1;
  } finally {
    await Promise.all(cleanups.map((c) => c()));
  }
}
