import { posix } from 'node:path';
/** What the graph needs to know about a file. */
export interface SourceFile {
  /** POSIX path relative to the root. */
  path: string;
  /** Language id (e.g. `typescript`), if recognised. */
  language?: string;
  /** Source text. */
  original: string;
}

/** Internal dependency graph: file → files it imports (POSIX paths relative to the root). */
export type DependencyGraph = Map<string, string[]>;

interface Resolver {
  /** Import specifiers found in the source. */
  extract(source: string): string[];
  /** Resolve a specifier to packed file path(s), if it names any. */
  resolve(spec: string, from: string, files: FileIndex): string | string[] | undefined;
}

class FileIndex {
  readonly paths: Set<string>;
  /** Directory → files directly in it (for package-level languages like Go). */
  readonly byDir = new Map<string, string[]>();
  /** Go modules in the pack: module path → directory of its go.mod. */
  readonly goModules: { path: string; dir: string }[] = [];

  constructor(files: readonly SourceFile[]) {
    this.paths = new Set(files.map((f) => f.path));
    for (const f of files) {
      const dir = posix.dirname(f.path);
      (this.byDir.get(dir) ?? this.byDir.set(dir, []).get(dir)!).push(f.path);
      if (posix.basename(f.path) === 'go.mod') {
        const module = /^\s*module\s+(\S+)/m.exec(f.original)?.[1];
        if (module) this.goModules.push({ path: module, dir });
      }
    }
    // Longest module path first, so nested modules win.
    this.goModules.sort((a, b) => b.path.length - a.path.length);
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

/** Resolve a dotted Python module (optionally relative, e.g. `..pkg.mod`) to a file. */
function resolvePythonModule(spec: string, from: string, files: FileIndex): string | undefined {
  const dots = /^\.+/.exec(spec)?.[0].length ?? 0;
  let dir = '.';
  if (dots) {
    dir = posix.dirname(from);
    for (let i = 1; i < dots; i++) dir = posix.dirname(dir);
  }
  const rel = spec.slice(dots).split('.').filter(Boolean).join('/');
  const base = posix.normalize(posix.join(dir, rel || '.'));
  const clean = base === '.' ? '' : base;
  const direct = files.first(clean ? [`${clean}.py`, `${clean}/__init__.py`, `${clean}.pyi`] : ['__init__.py']);
  if (direct || dots || !rel) return direct;
  // Absolute imports: the package may live under a source root such as src/.
  const matches = [...files.endingWith(`${rel}.py`), ...files.endingWith(`${rel}/__init__.py`)];
  return matches.length === 1 ? matches[0] : undefined;
}

const python: Resolver = {
  extract(s) {
    const specs = all(s, /^\s*import\s+([A-Za-z_][\w.]*(?:\s*,\s*[A-Za-z_][\w.]*)*)/gm).flatMap((l) => l.split(',').map((x) => x.trim()));
    for (const m of s.matchAll(/^\s*from\s+(\.+[\w.]*|[A-Za-z_][\w.]*)\s+import\s+(\([^)]*\)|[^\n#;]+)/gm)) {
      const names = m[2]!
        .replace(/[()\\]/g, ' ')
        .split(',')
        .map((raw) => raw.trim().split(/\s+as\s+/)[0]!.trim())
        .filter((name) => /^[A-Za-z_]\w*$/.test(name));
      // Encoded as module NUL name NUL name…, resolved together below.
      specs.push([m[1]!, ...names].join('\u0000'));
    }
    return specs;
  },
  resolve(spec, from, files) {
    const [module, ...names] = spec.split('\u0000') as [string, ...string[]];
    // `from pkg import mod` names submodules when they exist; otherwise the names are
    // attributes of `pkg` itself.
    const submodules = names
      .map((name) => resolvePythonModule(/^\.+$/.test(module) ? `${module}${name}` : `${module}.${name}`, from, files))
      .filter((t): t is string => !!t);
    if (submodules.length) return submodules;
    return resolvePythonModule(module, from, files);
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
    // Only imports inside a module declared by a go.mod in the pack are internal.
    const module = files.goModules.find((m) => spec === m.path || spec.startsWith(`${m.path}/`));
    if (!module) return undefined;
    const sub = spec.slice(module.path.length + 1);
    const dir = posix.normalize(posix.join(module.dir, sub || '.'));
    if (dir === posix.dirname(from)) return undefined;
    const inDir = files.byDir.get(dir)?.filter((f) => f.endsWith('.go') && !f.endsWith('_test.go'));
    return inDir?.length ? [...inDir].sort()[0] : undefined;
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

/** A path relative to the importing file (`./x.sol`, `util.zig`), else a unique suffix match. */
function relativeOrUnique(spec: string, from: string, files: FileIndex): string | undefined {
  const local = posix.normalize(posix.join(posix.dirname(from), spec));
  if (files.has(local)) return local;
  const matches = files.endingWith(spec.replace(/^(\.\.?\/)+/, ''));
  return matches.length === 1 ? matches[0] : undefined;
}

const objc: Resolver = {
  extract: (s) => all(s, /^\s*#\s*(?:include|import)\s+"([^"]+)"/gm),
  resolve: relativeOrUnique,
};

const zig: Resolver = {
  // `@import("std")` names a package; only file imports are internal.
  extract: (s) => all(s, /@import\s*\(\s*"([^"]+\.zig)"\s*\)/g),
  resolve: relativeOrUnique,
};

const solidity: Resolver = {
  extract: (s) => all(s, /^\s*import\s+(?:[^'";]*\bfrom\s+)?["']([^"']+)["']/gm),
  resolve: relativeOrUnique,
};

const julia: Resolver = {
  extract: (s) => all(s, /\binclude\s*\(\s*"([^"]+)"\s*\)/g),
  resolve: relativeOrUnique,
};

const haskell: Resolver = {
  extract: (s) => all(s, /^import\s+(?:qualified\s+)?([A-Z][\w.]*)/gm),
  resolve(spec, _from, files) {
    // `Data.Stack` lives in `Data/Stack.hs`, under some source root (src/, lib/, app/…).
    const matches = files.endingWith(`${spec.replace(/\./g, '/')}.hs`);
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

const lua: Resolver = {
  extract: (s) => all(s, /\brequire\s*\(?\s*['"]([\w./-]+)['"]/g),
  resolve(spec, _from, files) {
    const path = spec.replace(/\./g, '/');
    for (const candidate of [`${path}.lua`, `${path}/init.lua`]) {
      if (files.has(candidate)) return candidate;
      // Common layouts keep modules under lua/ or src/.
      const matches = files.endingWith(candidate);
      if (matches.length === 1) return matches[0];
    }
    return undefined;
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
  lua,
  objc,
  zig,
  solidity,
  julia,
  haskell,
};

/** Build the internal import graph of a pack (edges to files outside the pack are dropped). */
export function dependencyGraph(result: { files: readonly SourceFile[] }): DependencyGraph {
  const index = new FileIndex(result.files);
  const graph: DependencyGraph = new Map();
  for (const file of result.files) {
    const resolver = file.language ? RESOLVERS[file.language] : undefined;
    if (!resolver) continue;
    const deps = new Set<string>();
    for (const spec of resolver.extract(file.original)) {
      const resolved = resolver.resolve(spec, file.path, index);
      for (const target of Array.isArray(resolved) ? resolved : resolved ? [resolved] : []) {
        if (target !== file.path) deps.add(target);
      }
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
export function renderGraph(graph: DependencyGraph, files: readonly { path: string }[]): string {
  const order = new Map(files.map((f, i) => [f.path, i]));
  return [...graph]
    .sort(([a], [b]) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
    .map(([from, deps]) => `${from} -> ${deps.join(', ')}`)
    .join('\n');
}

/**
 * Files within `depth` import hops of `seeds`, in either direction (what they import and
 * what imports them). The seeds themselves are not included.
 */
export function relatedFiles(graph: DependencyGraph, seeds: Iterable<string>, depth: number): Set<string> {
  const neighbours = new Map<string, string[]>();
  const link = (a: string, b: string) => (neighbours.get(a) ?? neighbours.set(a, []).get(a)!).push(b);
  for (const [from, deps] of graph) {
    for (const to of deps) {
      link(from, to);
      link(to, from);
    }
  }
  const seen = new Set(seeds);
  const related = new Set<string>();
  let frontier = [...seen];
  for (let hop = 0; hop < depth && frontier.length; hop++) {
    const next: string[] = [];
    for (const path of frontier) {
      for (const n of neighbours.get(path) ?? []) {
        if (seen.has(n)) continue;
        seen.add(n);
        related.add(n);
        next.push(n);
      }
    }
    frontier = next;
  }
  return related;
}
