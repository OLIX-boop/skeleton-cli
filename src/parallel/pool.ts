import { existsSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { EncodingName } from '../tokens/pricing.js';
import type { TransformOptions } from '../engine/transform.js';

/** Work a pool thread can do. */
export type Task =
  | { type: 'transform'; path: string; content: string; options: TransformOptions; extensions: Record<string, string> }
  | { type: 'count'; encoding: EncodingName; texts: string[] };

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface Slot {
  worker: Worker;
  inFlight: Map<number, Pending>;
  dead: boolean;
}

/** A worker thread exited or crashed; the task can be retried on the main thread. */
export class WorkerFailure extends Error {}

/**
 * Worker threads that transform files and count tokens in parallel. Idle workers don't keep
 * the process alive, so a pool can stay around for later packs (watch mode, MCP).
 */
export class WorkerPool {
  private readonly slots: Slot[];
  private nextId = 0;

  constructor(size: number, script: string) {
    this.slots = Array.from({ length: size }, () => {
      const worker = new Worker(script);
      const slot: Slot = { worker, inFlight: new Map(), dead: false };
      worker.on('message', (msg: { id: number; result?: unknown; error?: string }) => {
        const pending = slot.inFlight.get(msg.id);
        if (!pending) return;
        slot.inFlight.delete(msg.id);
        if (!slot.inFlight.size) worker.unref();
        if (msg.error !== undefined) pending.reject(new Error(msg.error));
        else pending.resolve(msg.result);
      });
      const fail = (reason: string) => {
        slot.dead = true;
        for (const p of slot.inFlight.values()) p.reject(new WorkerFailure(reason));
        slot.inFlight.clear();
      };
      worker.on('error', (error) => fail(error.message));
      worker.on('exit', (code) => fail(`worker exited with code ${code}`));
      worker.unref();
      return slot;
    });
  }

  get size(): number {
    return this.slots.filter((s) => !s.dead).length;
  }

  /** Run a task on the least busy worker. */
  run<T>(task: Task): Promise<T> {
    const live = this.slots.filter((s) => !s.dead);
    if (!live.length) return Promise.reject(new WorkerFailure('no live workers'));
    const slot = live.reduce((a, b) => (b.inFlight.size < a.inFlight.size ? b : a));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      slot.inFlight.set(id, { resolve: resolve as (v: unknown) => void, reject });
      // Keep the process alive while work is outstanding.
      slot.worker.ref();
      slot.worker.postMessage({ id, task });
    });
  }

  async close(): Promise<void> {
    await Promise.all(this.slots.map((s) => s.worker.terminate()));
  }
}

let pool: WorkerPool | undefined;
let enabled = false;

/** The compiled worker script, or `undefined` when running from sources (tests, tsx). */
function workerScript(): string | undefined {
  const path = fileURLToPath(new URL('./worker.js', import.meta.url));
  return existsSync(path) ? path : undefined;
}

/**
 * How many worker threads to use: `ASTPACK_WORKERS` if set (0 disables them), else one per
 * CPU core beyond the first, at most 6 (each thread loads its own grammars).
 */
export function workerCount(env: NodeJS.ProcessEnv = process.env): number {
  const configured = env.ASTPACK_WORKERS;
  if (configured !== undefined && configured !== '') {
    const n = Number(configured);
    return Number.isInteger(n) && n > 0 ? Math.min(n, 64) : 0;
  }
  const auto = Math.min(6, availableParallelism() - 1);
  // A single automatic worker would only add overhead next to the main thread.
  return auto >= 2 ? auto : 0;
}

/**
 * Turn on parallel transforms and counts for work of this size, when worthwhile and
 * possible. Returns whether a pool is active.
 */
export function enablePool(workItems: number): boolean {
  if (enabled) return true;
  // Starting threads costs ~100 ms each plus grammar loading; small packs are faster inline.
  if (workItems < 200) return false;
  const size = workerCount();
  const script = workerScript();
  if (size < 1 || !script) return false;
  pool ??= new WorkerPool(size, script);
  enabled = true;
  return true;
}

/** The pool tasks should go to, if one is enabled and has live workers. */
export function activePool(): WorkerPool | undefined {
  return enabled && pool && pool.size > 0 ? pool : undefined;
}

/** Stop the pool's threads (tests, or a long-running host shutting down). */
export async function closePool(): Promise<void> {
  enabled = false;
  const p = pool;
  pool = undefined;
  await p?.close();
}
