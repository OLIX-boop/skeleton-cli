// Fetches the Tree-sitter grammars astpack uses from npm (pinned versions, no install
// scripts), and writes them to grammars/ as brotli-compressed WASM plus a manifest.
//
//   node scripts/vendor-grammars.mjs          # regenerate grammars/
//
// The output is committed, so builds and installs never need the network or the grammar
// packages themselves. Bump a version below, run this, run the tests, commit.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync, constants } from 'node:zlib';

/** grammar file name (without .wasm) → npm package providing it. */
const GRAMMARS = {
  'tree-sitter-typescript': 'tree-sitter-typescript@0.23.2',
  'tree-sitter-tsx': 'tree-sitter-typescript@0.23.2',
  'tree-sitter-javascript': 'tree-sitter-javascript@0.25.0',
  'tree-sitter-python': 'tree-sitter-python@0.25.0',
  'tree-sitter-go': 'tree-sitter-go@0.25.0',
  'tree-sitter-rust': 'tree-sitter-rust@0.24.0',
  'tree-sitter-java': 'tree-sitter-java@0.23.5',
  'tree-sitter-c_sharp': 'tree-sitter-c-sharp@0.23.5',
  'tree-sitter-c': 'tree-sitter-c@0.24.1',
  'tree-sitter-cpp': 'tree-sitter-cpp@0.23.4',
  'tree-sitter-ruby': 'tree-sitter-ruby@0.23.1',
  'tree-sitter-php': 'tree-sitter-php@0.24.2',
  'tree-sitter-kotlin': '@tree-sitter-grammars/tree-sitter-kotlin@1.1.0',
  'tree-sitter-scala': 'tree-sitter-scala@0.24.0',
  'tree-sitter-dart': 'tree-sitter-dart@1.0.0',
  'tree-sitter-elixir': 'tree-sitter-elixir@0.3.5',
  'tree-sitter-bash': 'tree-sitter-bash@0.25.1',
  'tree-sitter-lua': '@tree-sitter-grammars/tree-sitter-lua@0.4.1',
  // No newer WASM build is published for Swift; use the prebuilt collection.
  'tree-sitter-swift': 'tree-sitter-wasms@0.1.13',
};

const work = mkdtempSync(join(tmpdir(), 'astpack-grammars-'));
const target = new URL('../grammars/', import.meta.url);
const extracted = new Map();

function extract(spec) {
  if (extracted.has(spec)) return extracted.get(spec);
  const dir = join(work, String(extracted.size));
  mkdirSync(dir);
  const tarball = execFileSync('npm', ['pack', spec, '--silent'], { cwd: dir, encoding: 'utf8' }).trim().split('\n').pop();
  execFileSync('tar', ['-xzf', tarball], { cwd: dir });
  extracted.set(spec, join(dir, 'package'));
  return join(dir, 'package');
}

function findWasm(dir, name) {
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name === `${name}.wasm`) return join(entry.parentPath ?? entry.path, entry.name);
  }
  throw new Error(`${name}.wasm not found in ${dir}`);
}

try {
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  const manifest = {};
  let raw = 0;
  let packed = 0;
  for (const [name, spec] of Object.entries(GRAMMARS)) {
    const bytes = readFileSync(findWasm(extract(spec), name));
    const compressed = brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } });
    writeFileSync(new URL(`${name}.wasm.br`, target), compressed);
    manifest[name] = { package: spec, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
    raw += bytes.length;
    packed += compressed.length;
    console.log(`${name.padEnd(24)} ${spec}`);
  }
  writeFileSync(new URL('manifest.json', target), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Vendored ${Object.keys(GRAMMARS).length} grammars: ${(raw / 1e6).toFixed(1)} MB -> ${(packed / 1e6).toFixed(1)} MB`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
