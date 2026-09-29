import { existsSync, watch } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, relative, resolve } from 'node:path';
import type { Command } from 'commander';
import { fitToBudget, type BudgetReport } from '../budget.js';
import { dependencyGraph } from '../deps.js';
import { findConfig, loadConfig, type AstpackConfig } from '../config.js';
import { PRESETS } from '../presets.js';
import { registerExtensions, type LanguageId } from '../languages/index.js';
import { changedFiles, cloneRemote, diffText, parseRemote, resolveRef } from '../git.js';
import { OUTPUT_EXTENSIONS, render } from '../output/index.js';
import { pack, type PackOptions } from '../pack.js';
import { partPath, splitPack, type SplitReport } from '../split.js';
import { redactSecrets } from '../security/secrets.js';
import { computeStats, countClaudeTokens, DEFAULT_MODELS, findModel, MODELS, type PackStats } from '../tokens/index.js';
import { VERSION } from '../version.js';
import { toPosix } from '../walker/rules.js';
import { copyToClipboard } from './clipboard.js';
import { makeColors, shouldColor, type Colors } from './colors.js';
import { formatNumber, formatPercent, parseSize, parseTokenCount } from './format.js';
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
        if (!fromCli('skeleton') && !fromCli('full') && !fromCli('outline')) {
          next.full = value === 'full';
          next.outline = value === 'outline';
        }
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

/** Machine-readable summary for `--stats-json`. */
export function statsToJson(stats: PackStats, extra: { budget?: BudgetReport; parts?: number[] }) {
  return {
    files: { included: stats.filesIncluded, scanned: stats.entriesScanned, skipped: stats.skipped, byStrategy: stats.byStrategy },
    strippedBodies: stats.strippedBodies,
    strippedComments: stats.strippedComments,
    output: { bytes: stats.outputBytes, chars: stats.outputChars },
    tokens: stats.tokens,
    savedRatio: Number(stats.savedRatio.toFixed(4)),
    costs: stats.costs.map((c) => ({ model: c.model.id, tokens: c.tokens, usd: Number(c.usd.toFixed(6)), rawUsd: Number(c.baselineUsd.toFixed(6)) })),
    ...(extra.budget
      ? { budget: { maxTokens: extra.budget.maxTokens, tokens: extra.budget.tokens, fits: extra.budget.fits, changes: extra.budget.changes } }
      : {}),
    ...(extra.parts ? { parts: extra.parts } : {}),
    redacted: stats.redactedFiles,
    parseErrors: stats.parseErrorFiles,
    filesByTokens: stats.files.map((f) => ({ path: f.path, tokens: f.tokens, rawTokens: f.originalTokens, strategy: f.strategy, focused: f.focused })),
  };
}

/** What one pack run produced, for watch-mode status lines. */
export interface WatchReport {
  files: number;
  tokens: number;
  savedRatio: number;
  destination: string;
  /** Files written by the run (never trigger a rebuild). */
  outputs: string[];
  /** Paths the pack ignored (directories end with `/`); changes under them are skipped. */
  ignored?: string[];
}

export interface WatchOptions {
  root: string;
  outputs: readonly string[];
  /** Root-relative POSIX paths the pack ignores (directories end with `/`). */
  ignored?: readonly string[];
  rerun: () => Promise<WatchReport>;
  io: CliIO;
  colors: Colors;
  signal: AbortSignal;
  /** Quiet period before rebuilding, in ms (default 250). */
  debounceMs?: number;
}

const WATCH_IGNORED_SEGMENTS = new Set(['.git', 'node_modules', '.hg', '.svn']);

/** Re-run the pack whenever something under `root` changes, until `signal` aborts. */
export function watchLoop(options: WatchOptions): Promise<void> {
  const { root, io, colors, signal } = options;
  const own = options.outputs.map((p) => {
    // Part files share partPath()'s naming: out.md -> out.part1.md, out.part2.md, ...
    const template = partPath(p, 0);
    const marker = template.lastIndexOf('.part0');
    return { exact: p, partPrefix: template.slice(0, marker + '.part'.length) };
  });
  const isOwnOutput = (abs: string) => own.some((o) => abs === o.exact || abs.startsWith(o.partPrefix));
  let ignored = options.ignored ?? [];
  const isIgnored = (rel: string) => ignored.some((i) => (i.endsWith('/') ? rel.startsWith(i) || `${rel}/` === i : rel === i));

  return new Promise<void>((resolveDone) => {
    io.stderr.write(colors.dim(`Watching ${root} for changes (Ctrl+C to stop)…\n`));
    let timer: NodeJS.Timeout | undefined;
    let running = false;
    let pending = false;

    const rebuild = async () => {
      if (running) {
        pending = true;
        return;
      }
      running = true;
      const started = Date.now();
      try {
        const r = await options.rerun();
        if (r.ignored) ignored = r.ignored;
        const time = new Date().toLocaleTimeString('en-GB');
        const saved = r.savedRatio > 0 ? colors.dim(` (−${formatPercent(r.savedRatio)})`) : '';
        io.stderr.write(
          `${colors.green('↻')} ${colors.dim(time)} ${formatNumber(r.files)} files · ${formatNumber(r.tokens)} tokens${saved} → ${r.destination} ${colors.dim(`${Date.now() - started}ms`)}\n`,
        );
      } catch (error) {
        io.stderr.write(`${colors.red('error:')} ${(error as Error).message}\n`);
      } finally {
        running = false;
        if (pending && !signal.aborted) {
          pending = false;
          schedule();
        }
      }
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void rebuild(), options.debounceMs ?? 250);
    };

    const watcher = watch(root, { recursive: true }, (_event, filename) => {
      if (filename) {
        const rel = toPosix(String(filename));
        if (rel.split('/').some((seg) => WATCH_IGNORED_SEGMENTS.has(seg))) return;
        if (isOwnOutput(resolve(root, rel)) || isIgnored(rel)) return;
      }
      schedule();
    });
    const finish = () => {
      clearTimeout(timer);
      watcher.close();
      resolveDone();
    };
    if (signal.aborted) finish();
    else signal.addEventListener('abort', finish, { once: true });
  });
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
    let configFocus: { dir: string; paths: string[] } | undefined;
    const configKeys = new Set<string>();
    if (opts.config !== false) {
      const path = typeof opts.config === 'string' ? resolve(io.cwd, opts.config) : findConfig(opts.remote ? [io.cwd] : [root, io.cwd]);
      if (path) {
        const loaded = await loadConfig(path);
        for (const w of loaded.warnings) warn(io, errColors, w);
        const fromCli = (key: string) => command.getOptionValueSource(key) === 'cli';
        opts = applyConfig(opts, loaded.config, fromCli);
        for (const key of Object.keys(loaded.config)) configKeys.add(key);
        if (loaded.config.focus && !fromCli('focus')) configFocus = { dir: loaded.dir, paths: loaded.config.focus };
      }
    }

    // Presets fill in whatever neither the command line nor the config file set.
    if (opts.preset) {
      const unset = Object.fromEntries(
        Object.entries(PRESETS[opts.preset]!.options).filter(([key]) => !configKeys.has(key)),
      ) as AstpackConfig;
      opts = applyConfig(opts, unset, (key) => command.getOptionValueSource(key) === 'cli');
    }

    if (opts.extensions) registerExtensions(opts.extensions as Record<string, LanguageId>);

    const summaryStream = opts.stdout ? io.stderr : io.stdout;
    const colors = makeColors(opts.color && shouldColor(summaryStream));

    if ([opts.skeleton, opts.full, opts.outline].filter(Boolean).length > 1) {
      throw new Error('--skeleton, --full and --outline are mutually exclusive');
    }
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

    const requestedChanged = opts.changed === true ? 'HEAD' : opts.changed || undefined;
    const changedRef = requestedChanged ? await resolveRef(requestedChanged, root) : undefined;
    // Config focus paths are relative to the config file, or to the clone with --remote.
    const baseFocus = configFocus
      ? configFocus.paths.map((f) => (/[*?[\]{}]/.test(f) && !existsSync(resolve(configFocus.dir, f)) ? f : resolve(opts.remote ? root : configFocus.dir, f)))
      : [...opts.focus];

    const once = async (initial: boolean): Promise<WatchReport> => {
      // Recomputed on every run so --watch picks up newly changed files.
      const focus = [...baseFocus];
      if (changedRef) {
        const changed = await changedFiles(root, changedRef);
        if (!changed.length && initial) warn(io, errColors, `no files changed vs ${changedRef}`);
        focus.push(...changed);
      }

      const outputPath = opts.stdout ? undefined : resolve(io.cwd, opts.output ?? `astpack-output.${OUTPUT_EXTENSIONS[opts.format]}`);
      const ignore = [...opts.ignore];
      // Never pack our own output file.
      if (outputPath) {
        const rel = toPosix(relative(root, outputPath));
        if (rel && !rel.startsWith('..')) ignore.push(`/${rel}`, `/${partPath(rel, 0).replace('.part0', '.part*')}`);
      }
      // Nor the stats file from a previous run.
      if (opts.statsJson) {
        const rel = toPosix(relative(root, resolve(io.cwd, opts.statsJson)));
        if (rel && !rel.startsWith('..')) ignore.push(`/${rel}`);
      }

      const showProgress = !opts.quiet && !!io.stderr.isTTY;
      const packOptions: PackOptions = {
        mode: opts.full ? 'full' : opts.outline ? 'outline' : 'skeleton',
        focus,
        related: opts.related === true ? 1 : opts.related || 0,
        query: opts.query,
        queryLimit: opts.queryLimit,
        // Relative --focus paths name files inside a remote repository, not the local cwd.
        cwd: opts.remote ? root : io.cwd,
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
      if (opts.focus.length && !result.files.some((f) => f.focused && !f.matched)) {
        warn(io, errColors, `no files matched --focus ${opts.focus.join(', ')}`);
      }

      const diffRef = opts.diff === true ? (changedRef ?? 'HEAD') : opts.diff ? await resolveRef(opts.diff, root) : undefined;
      const renderOptions = {
        projectName,
        tree: opts.tree,
        instructions: await readInstructions(opts.instructions, io.cwd),
        focus: [
          ...opts.focus,
          ...(changedRef ? [`changed vs ${changedRef}`] : []),
          ...(opts.query ? [`files matching "${opts.query}"`] : []),
        ],
        version: VERSION,
        diff: diffRef ? { ref: diffRef, text: maybeRedact(await diffText(root, diffRef), opts.redact) } : undefined,
        dependencies: opts.deps ? dependencyGraph(result) : undefined,
      };

      let document: string | undefined;
      let budget: BudgetReport | undefined;
      const splitting = !!(outputPath && opts.splitTokens);
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
      } else if (!splitting) {
        document = render(opts.format, result, renderOptions);
      }

      const destinations: string[] = [];
      const display = (p: string) => {
        const shown = toPosix(relative(io.cwd, p));
        return shown && !shown.startsWith('..') ? shown : p;
      };
      let parts: SplitReport | undefined;
      const write = !opts.dryRun;
      if (outputPath && write) await mkdir(dirname(outputPath), { recursive: true });
      if (outputPath && opts.splitTokens) {
        parts = splitPack(result, {
          maxTokens: opts.splitTokens!,
          render: (r, part) => render(opts.format, r, { ...renderOptions, part }),
        });
        if (write) for (const part of parts.parts) await writeFile(partPath(outputPath, part.index), part.document);
        const first = display(partPath(outputPath, 1));
        if (write) destinations.push(`Wrote ${parts.parts.length} part${parts.parts.length === 1 ? '' : 's'} (${first}${parts.parts.length > 1 ? ' …' : ''})`);
        for (const path of parts.oversized) warn(io, errColors, `${path} alone exceeds --split-tokens ${formatNumber(opts.splitTokens!)}`);
        document = parts.parts.map((p) => p.document).join('\n');
      } else if (outputPath) {
        document ??= render(opts.format, result, renderOptions);
        if (write) {
          await writeFile(outputPath, document);
          destinations.push(`Wrote ${display(outputPath)}`);
        }
      } else {
        document ??= render(opts.format, result, renderOptions);
        if (write) io.stdout.write(document);
      }
      document ??= render(opts.format, result, renderOptions);
      if (opts.clipboard && write) {
        await copyToClipboard(document);
        destinations.push('copied to clipboard');
      }

      let lastTokens = 0;
      let savedRatio = 0;
      if (!opts.quiet || opts.statsJson || opts.watch) {
        const modelIds = opts.models.length ? opts.models : [...DEFAULT_MODELS];
        // Exact Claude counts upload the document, so only do it for the summary that is shown
        // (the initial run), not on every --watch rebuild.
        const exactTokens =
          opts.claudeTokens && initial && !opts.quiet
            ? await countClaudeTokens(document, modelIds.map(findModel).filter((m): m is NonNullable<typeof m> => !!m))
            : undefined;
        const stats = computeStats(result, document, { models: modelIds, exactTokens });
        lastTokens = stats.tokens.cl100k_base.output;
        savedRatio = stats.savedRatio;
        if (opts.statsJson) {
          const statsPath = resolve(io.cwd, opts.statsJson);
          await mkdir(dirname(statsPath), { recursive: true });
          await writeFile(statsPath, `${JSON.stringify(statsToJson(stats, { budget, parts: parts?.parts.map((p) => p.tokens) }), null, 2)}\n`);
        }
        if (!opts.quiet && initial) {
          const label = !write ? 'Dry run: nothing written' : destinations.length ? destinations.join(', ') : 'Wrote to stdout';
          summaryStream.write(
            `${renderSummary(stats, { colors, top: opts.top, outputLabel: label, mode: result.mode, budget, parts: parts?.parts.map((p) => p.tokens), queryHits: result.queryHits })}\n`,
          );
        }
      }
      return {
        files: result.files.length,
        tokens: lastTokens,
        savedRatio,
        destination: destinations.join(', ') || (write ? 'stdout' : 'dry run'),
        outputs: [outputPath, opts.statsJson ? resolve(io.cwd, opts.statsJson) : undefined].filter((p): p is string => !!p),
        ignored: result.skipped.filter((e) => e.reason === 'ignored').map((e) => e.path),
      };
    };

    if (opts.watch && (opts.stdout || opts.remote)) throw new Error('--watch writes a file; it cannot be combined with --stdout or --remote');
    const first = await once(true);
    if (opts.watch) {
      const controller = new AbortController();
      const stop = () => controller.abort();
      const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
      // `on`, not `once`: a terminal Ctrl+C can arrive twice (it also reaches the launcher).
      for (const s of signals) process.on(s, stop);
      try {
        await watchLoop({ root, outputs: first.outputs, ignored: first.ignored, rerun: () => once(false), io, colors: errColors, signal: controller.signal });
      } finally {
        for (const s of signals) process.off(s, stop);
      }
    }
    return 0;
  } catch (error) {
    io.stderr.write(`${errColors.red('error:')} ${(error as Error).message}\n`);
    return 1;
  } finally {
    await Promise.all(cleanups.map((c) => c()));
  }
}
