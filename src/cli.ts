#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * The Tree-sitter grammars contain a few enormous functions. Optimizing them with TurboFan
 * costs more time than a CLI run gains back, and on Node 24 it can take over 1 GB of memory.
 * The baseline compiler (Liftoff) parses just as fast here. V8 freezes its flags at startup
 * on current Node versions, so the CLI re-launches itself once with `--liftoff-only`.
 * Set ASTPACK_WASM_TIERUP=1 to keep V8's default tiering.
 */
function relaunchWithLiftoff(): boolean {
  if (process.env.ASTPACK_WASM_TIERUP || process.execArgv.includes('--liftoff-only')) return false;
  const child = spawn(process.execPath, ['--liftoff-only', ...process.execArgv, fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: 'inherit',
  });
  // Terminal signals reach both processes; let the child decide how to exit.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => child.kill(signal));
  }
  child.on('error', (error) => {
    process.stderr.write(`astpack: failed to start: ${error.message}\n`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
  return true;
}

if (!relaunchWithLiftoff()) {
  // Exit quietly when the reader of a pipe goes away (e.g. `astpack --stdout | head`).
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EPIPE') process.exit(0);
      throw error;
    });
  }

  const { run } = await import('./cli/program.js');
  run(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`${String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
