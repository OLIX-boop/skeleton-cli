import { readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import ignore, { type Ignore } from 'ignore';

/** A set of gitignore-style rules and where they are anchored. */
interface RuleSet {
  ig: Ignore;
  /**
   * For rules at or below the scan root: the POSIX directory (relative to the root) they
   * apply to, '' for the root itself. Paths outside it are not affected.
   */
  base?: string;
  /**
   * For rules in a parent directory of the scan root (e.g. the repo-level `.gitignore`
   * when packing a sub-package): the scan root's path relative to that directory.
   */
  prefix?: string;
}

export function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}

/** Relative POSIX path from `from` to `to`. */
export function relPosix(from: string, to: string): string {
  return toPosix(relative(from, to));
}

async function readIfExists(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Hierarchical, immutable ignore rules. Rule sets are consulted from the least to the most
 * specific so that nested `.gitignore` files can override (including `!negation`) their
 * parents, as git does.
 */
export class IgnoreRules {
  private constructor(private readonly sets: readonly RuleSet[]) {}

  static empty(): IgnoreRules {
    return new IgnoreRules([]);
  }

  /** Rules that apply at `base` (POSIX path relative to the scan root, '' = root). */
  with(base: string, patterns: string | readonly string[]): IgnoreRules {
    return this.push({ ig: compile(patterns), base });
  }

  /** Rules from an ancestor directory, which sees the scan root at `prefix`. */
  withAncestor(prefix: string, patterns: string | readonly string[]): IgnoreRules {
    return this.push({ ig: compile(patterns), prefix });
  }

  /** Load an ignore file from `absDir` (at `base`) if it exists. */
  async withFile(absDir: string, base: string, fileName: string): Promise<IgnoreRules> {
    const content = await readIfExists(join(absDir, fileName));
    return content === undefined ? this : this.with(base, content);
  }

  /**
   * Whether a POSIX path relative to the scan root is ignored. Directories must be tested
   * with `isDir = true` so that `dir/` patterns match.
   */
  ignores(path: string, isDir: boolean): boolean {
    let ignored = false;
    for (const set of this.sets) {
      let rel: string;
      if (set.prefix !== undefined) {
        rel = set.prefix ? `${set.prefix}/${path}` : path;
      } else if (!set.base) {
        rel = path;
      } else if (path.startsWith(`${set.base}/`)) {
        rel = path.slice(set.base.length + 1);
      } else {
        continue;
      }
      const result = set.ig.test(isDir ? `${rel}/` : rel);
      if (result.ignored) ignored = true;
      else if (result.unignored) ignored = false;
    }
    return ignored;
  }

  /**
   * Whether ancestor rules ignore the scan root itself (or one of the directories leading
   * to it), e.g. packing `node_modules/pkg` inside a repo that ignores `node_modules/`.
   */
  ignoresRoot(): boolean {
    const ancestors = this.sets.filter((set) => set.prefix);
    if (!ancestors.length) return false;
    // The longest prefix belongs to the highest ancestor; walk its directories top-down.
    const full = ancestors.map((set) => set.prefix!.split('/')).reduce((a, b) => (b.length > a.length ? b : a));
    for (let depth = 1; depth <= full.length; depth++) {
      let ignored = false;
      for (const set of ancestors) {
        const own = set.prefix!.split('/');
        const anchorDepth = full.length - own.length; // how far below the top this set lives
        if (depth <= anchorDepth) continue; // directory is above this rule set
        const result = set.ig.test(`${full.slice(anchorDepth, depth).join('/')}/`);
        if (result.ignored) ignored = true;
        else if (result.unignored) ignored = false;
      }
      if (ignored) return true;
    }
    return false;
  }

  /** A copy without the ancestor rule sets. */
  withoutAncestors(): IgnoreRules {
    return new IgnoreRules(this.sets.filter((s) => s.prefix === undefined));
  }

  private push(set: RuleSet): IgnoreRules {
    return new IgnoreRules([...this.sets, set]);
  }
}

function compile(patterns: string | readonly string[]): Ignore {
  return ignore({ allowRelativePaths: true }).add(patterns as string | string[]);
}

/**
 * If `absRoot` is inside (but not at the top of) a git work tree, return the directories
 * from the repository root down to `absRoot`'s parent. Otherwise return an empty list.
 */
export async function ancestorDirsWithinRepo(absRoot: string): Promise<string[]> {
  const chain: string[] = [];
  let dir = absRoot;
  for (;;) {
    if (await exists(join(dir, '.git'))) return chain.reverse();
    const parent = dirname(dir);
    if (parent === dir) return [];
    dir = parent;
    chain.push(dir);
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
