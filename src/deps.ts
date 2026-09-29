import { posix } from 'node:path';
import type { PackedFile, PackResult } from './pack.js';

/** Internal dependency graph: file → files it imports (POSIX paths relative to the root). */
export type DependencyGraph = Map<string, string[]>;

interface Resolver {
  /** Import specifiers found in the source. */
  extract(source: string): string[];
  /** Resolve a specifier to a packed file path, if it names one. */
  resolve(spec: string, from: string, files: FileIndex): string | undefined;
}

class FileIndex {
  readonly paths: Set<string>;
  /** Directory → files directly in it (for package-level languages like Go). */
  readonly byDir = new Map<string, string[]>();
  /** Path without extension → path (for suffix lookups like Java packages). */
  readonly bySuffix = new Map<string, string[]>();

  constructor(paths: readonly string[]) {
    this.paths = new Set(paths);
    for (const p of paths) {
      const dir = posix.dirname(p);
      (this.byDir.get(dir) ?? this.byDir.set(dir, []).get(dir)!).push(p);
    }
  }

  has(p: string): boolean {
    return this.paths.has(p);
  }

  first(candidates: readonly string[]): string | undefined {
    return candidates.find((c) => this.paths.has(c));
  }

  /** Files whose path ends with `/${suffix}` or equals it. */
  endingWith(suffix: string): string[] {
    const out: string[] = [];
    for (const p of this.paths) if (p === suffix || p.endsWith(`/${suffix}`)) out.push(p);
    return out;
  }
}

function all(source: string, re: RegExp, group = 1): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(re)) if (m[group]) out.push(m[group]);
  return out;
}

const JS_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte', '.astro', '.d.ts'];

const javascript: Resolver = {
  extract: (s) => [
    ...all(s, /\b(?:import|export)\s[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g),
    ...all(s, /\bimport\s*['"]([^'"]+)['"]/g),
    ...all(s, /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
  ],
  resolve(spec, from, files) {
    if (!spec.startsWith('.')) return undefined; // packages and path aliases
    const base = posix.normalize(posix.join(posix.dirname(from), spec));
    // NodeNext-style imports name the emitted .js file for a .ts source.
    const stripped = base.replace(/\.(m|c)?js$/, '');
    return files.first([
      base,
      ...JS_EXTENSIONS.map((e) => stripped + e),
      ...JS_EXTENSIONS.map((e) => `${base}/index${e}`),
    ]);
  },
};

const python: Resolver = {
  extract: (s) => [
    ...all(s, /^\s*from\s+(\.+[\w.]*|[A-Za-z_][\w.]*)\s+import\b/gm),
    ...all(s, /^\s*import\s+([A-Za-z_][\w.]*)/gm),
  ],
  resolve(spec, from, files) {
    let dir: string;
    let rest: string;
    const dots = /^\.+/.exec(spec)?.[0].length ?? 0;
    if (dots) {
      dir = posix.dirname(from);
      for (let i = 1; i < dots; i++) dir = posix.dirname(dir);
      rest = spec.slice(dots);
    } else {
      dir = '';
      rest = spec;
    }
    const rel = rest.split('.').filter(Boolean).join('/');
    const base = rel ? (dir && dir !== '.' ? `${dir}/${rel}` : rel) : dir;
    const direct = files.first([`${base}.py`, `${base}/__init__.py`, `${base}.pyi`]);
    if (direct || dots) return direct;
    // Absolute imports: the package may live under a source root such as src/.
    const matches = [...files.endingWith(`${rel}.py`), ...files.endingWith(`${rel}/__init__.py`)];
    return matches.length === 1 ? matches[0] : undefined;
  },
};

const go: Resolver = {
  extract(s) {
    const specs: string[] = [];
    for (const block of s.matchAll(/\bimport\s*\(([\s\S]*?)\)/g)) specs.push(...all(block[1]!, /"([^"]+)"/g));
    specs.push(...all(s, /\bimport\s+(?:[\w.]+\s+)?"([^"]+)"/g));
    return specs;
  },
  resolve(spec, from, files) {
    // Match the import path's tail against package directories in the pack.
    const parts = spec.split('/');
    for (let i = 0; i < parts.length; i++) {
      const dir = parts.slice(i).join('/');
      const inDir = files.byDir.get(dir)?.filter((f) => f.endsWith('.go') && !f.endsWith('_test.go'));
      if (inDir?.length && posix.dirname(from) !== dir) return inDir.sort()[0];
    }
    return undefined;
  },
};

const rust: Resolver = {
  extract: (s) => all(s, /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)\s*;/gm),
  resolve(spec, from, files) {
    const dir = posix.dirname(from);
    const own = /(?:^|\/)(?:main|lib|mod)\.rs$/.test(from) ? dir : `${dir}/${posix.basename(from, '.rs')}`;
    const base = own === '.' ? spec : `${own}/${spec}`;
    return files.first([`${base}.rs`, `${base}/mod.rs`]);
  },
};

const jvm: Resolver = {
  extract: (s) => all(s, /^\s*import\s+(?:static\s+)?([A-Za-z_][\w.]*[A-Za-z_]\w*)\s*;?\s*$/gm),
  resolve(spec, _from, files) {
    const path = spec.replace(/\./g, '/');
    for (const ext of ['.java', '.kt', '.scala']) {
      const matches = files.endingWith(path + ext);
      if (matches.length === 1) return matches[0];
    }
    return undefined;
  },
};

const cInclude: Resolver = {
  extract: (s) => all(s, /^\s*#\s*include\s+"([^"]+)"/gm),
  resolve(spec, from, files) {
    const local = posix.normalize(posix.join(posix.dirname(from), spec));
    if (files.has(local)) return local;
    const matches = files.endingWith(spec);
    return matches.length === 1 ? matches[0] : undefined;
  },
};

const ruby: Resolver = {
  extract: (s) => all(s, /\brequire_relative\s*\(?\s*['"]([^'"]+)['"]/g),
  resolve(spec, from, files) {
    const base = posix.normalize(posix.join(posix.dirname(from), spec));
    return files.first([base, `${base}.rb`]);
  },
};

const php: Resolver = {
  extract: (s) => all(s, /\b(?:require|include)(?:_once)?\s*\(?\s*(?:__DIR__\s*\.\s*)?['"]([^'"]+)['"]/g),
  resolve(spec, from, files) {
    const base = posix.normalize(posix.join(posix.dirname(from), spec.replace(/^\//, '')));
    return files.first([base]);
  },
};

const RESOLVERS: Record<string, Resolver> = {
  typescript: javascript,
  tsx: javascript,
  javascript,
  vue: javascript,
  svelte: javascript,
  astro: javascript,
  python,
  go,
  rust,
  java: jvm,
  kotlin: jvm,
  scala: jvm,
  c: cInclude,
  cpp: cInclude,
  ruby,
  php,
};

/** Build the internal import graph of a pack (edges to files outside the pack are dropped). */
export function dependencyGraph(result: PackResult): DependencyGraph {
  const index = new FileIndex(result.files.map((f) => f.path));
  const graph: DependencyGraph = new Map();
  for (const file of result.files) {
    const resolver = file.language ? RESOLVERS[file.language] : undefined;
    if (!resolver) continue;
    const deps = new Set<string>();
    for (const spec of resolver.extract(file.original)) {
      const target = resolver.resolve(spec, file.path, index);
      if (target && target !== file.path) deps.add(target);
    }
    if (deps.size) graph.set(file.path, [...deps].sort());
  }
  return graph;
}

/** Files ranked by how many other files import them. */
export function mostImported(graph: DependencyGraph, limit = 10): { path: string; importers: number }[] {
  const counts = new Map<string, number>();
  for (const deps of graph.values()) for (const d of deps) counts.set(d, (counts.get(d) ?? 0) + 1);
  return [...counts]
    .map(([path, importers]) => ({ path, importers }))
    .sort((a, b) => b.importers - a.importers || (a.path < b.path ? -1 : 1))
    .slice(0, limit);
}

/** Render the graph as compact text: one `file -> dep, dep` line per importing file. */
export function renderGraph(graph: DependencyGraph, files: readonly PackedFile[]): string {
  const order = new Map(files.map((f, i) => [f.path, i]));
  return [...graph]
    .sort(([a], [b]) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
    .map(([from, deps]) => `${from} -> ${deps.join(', ')}`)
    .join('\n');
}
