import { parentPort } from 'node:worker_threads';
import { computeTransform } from '../engine/transform.js';
import { registerExtensions, type LanguageId } from '../languages/index.js';
import { countUncached } from '../tokens/counter.js';
import type { Task } from './pool.js';

parentPort!.on('message', async ({ id, task }: { id: number; task: Task }) => {
  try {
    // The main thread's extension mappings travel with each task, so later registrations apply.
    if (task.type === 'transform') registerExtensions(task.extensions as Record<string, LanguageId>);
    const result =
      task.type === 'transform'
        ? await computeTransform(task.path, task.content, task.options)
        : task.texts.map((text) => countUncached(text, task.encoding));
    parentPort!.postMessage({ id, result });
  } catch (error) {
    parentPort!.postMessage({ id, error: (error as Error).message });
  }
});
