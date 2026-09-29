import { existsSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import ignore, { type Ignore } from 'ignore';
import { toPosix } from './rules.js';

const GLOB_CHARS = /[*?[\]{}!]/;

/**
 * Decides which files are "in focus" (kept as full source) given `--focus` arguments.
 *
 * Each target may be a file, a directory (everything beneath it matches), or a
 * gitignore-style glob such as `src/**\/*.test.ts`. Plain paths are resolved against the
 * current working directory and then made relative to the scan root.
 */
export class FocusMatcher {
  private readonly prefixes: string[] = [];
  private readonly globs: Ignore | undefined;

  constructor(targets: readonly string[], root: string, cwd = process.cwd()) {
    const globs: string[] = [];
    for (const raw of targets) {
      const target = raw.trim();
      if (!target) continue;
      const abs = isAbsolute(target) ? target : resolve(cwd, target);
      // Paths like `app/[id]/page.tsx` contain glob characters; an existing path wins.
      if (GLOB_CHARS.test(target) && !existsSync(abs)) {
        globs.push(target);
        continue;
      }
      const rel = toPosix(relative(root, abs)).replace(/\/+$/, '');
      this.prefixes.push(rel === '' ? '.' : rel);
    }
    this.globs = globs.length ? ignore({ allowRelativePaths: true }).add(globs) : undefined;
  }

  get isEmpty(): boolean {
    return this.prefixes.length === 0 && !this.globs;
  }

  /** Whether the file at `path` (POSIX, relative to the root) is focused. */
  matches(path: string): boolean {
    for (const prefix of this.prefixes) {
      if (prefix === '.' || path === prefix || path.startsWith(`${prefix}/`)) return true;
    }
    return this.globs?.ignores(path) ?? false;
  }

  /** Focus targets that point outside the scan root (likely user mistakes). */
  outsideRoot(): string[] {
    return this.prefixes.filter((p) => p === '..' || p.startsWith('../'));
  }
}
