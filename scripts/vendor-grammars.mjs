// Fetches the Tree-sitter grammars astpack uses from npm (pinned versions, no install
// scripts), and writes them to grammars/ as brotli-compressed WASM plus a manifest.
//
//   node scripts/vendor-grammars.mjs          # regenerate grammars/
//
// The output is committed, so builds and installs never need the network or the grammar
// packages themselves. Bump a version below, run this, run the tests, commit.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants } from 'node:zlib';

/**
 * grammar file name (without .wasm) → npm package providing it. Entries marked `build`
 * ship C sources but no WASM, so they are compiled with the tree-sitter CLI, which needs
 * Emscripten (`emcc` on PATH) or Docker/Podman.
 */
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
  'tree-sitter-zig': '@tree-sitter-grammars/tree-sitter-zig@1.1.2',
  'tree-sitter-haskell': 'tree-sitter-haskell@0.23.1',
  'tree-sitter-ocaml': 'tree-sitter-ocaml@0.24.2',
  'tree-sitter-ocaml_interface': 'tree-sitter-ocaml@0.24.2',
  'tree-sitter-julia': 'tree-sitter-julia@0.23.1',
  'tree-sitter-solidity': 'tree-sitter-solidity@1.2.13',
  'tree-sitter-objc': 'tree-sitter-objc@3.0.2',
  'tree-sitter-swift': {
    build: 'tree-sitter-swift@0.7.1',
    // Upstream never resets its state on `deserialize(NULL, 0)`, which runs at the start of
    // every parse: a raw-string counter left over from a broken file corrupts every later
    // file parsed with the same parser.
    patches: {
      'src/scanner.c': [
        [
          '    if (length < 4) {\n        return;\n    }\n',
          '    if (length < 4) {\n        ((struct ScannerState *)payload)->ongoing_raw_str_hash_count = 0;\n        return;\n    }\n',
        ],
      ],
    },
  },
};

/** tree-sitter CLI matching the runtime's ABI (web-tree-sitter 0.25). */
const TREE_SITTER_CLI = 'tree-sitter-cli@0.25.10';

function build({ build: spec, patches = {} }, name) {
  const dir = extract(spec);
  for (const [file, replacements] of Object.entries(patches)) {
    let text = readFileSync(join(dir, file), 'utf8');
    for (const [from, to] of replacements) {
      if (!text.includes(from)) throw new Error(`${spec}: patch for ${file} no longer applies`);
      text = text.replace(from, to);
    }
    writeFileSync(join(dir, file), text);
  }
  const out = join(dir, `${name}.wasm`);
  execFileSync('npx', ['--yes', TREE_SITTER_CLI, 'build', '--wasm', '-o', out], { cwd: dir, stdio: 'inherit' });
  return out;
}

const work = mkdtempSync(join(tmpdir(), 'astpack-grammars-'));
const target = fileURLToPath(new URL('../grammars/', import.meta.url));
// Build next to the target and swap it in only once everything succeeded.
const staging = `${target.replace(/[\\/]$/, '')}.staging`;
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
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const manifest = {};
  let raw = 0;
  let packed = 0;
  for (const [name, entry] of Object.entries(GRAMMARS)) {
    const spec = typeof entry === 'string' ? entry : entry.build;
    const bytes = readFileSync(typeof entry === 'string' ? findWasm(extract(spec), name) : build(entry, name));
    const compressed = brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } });
    writeFileSync(join(staging, `${name}.wasm.br`), compressed);
    manifest[name] = { package: spec, ...(typeof entry === 'string' ? {} : { built: TREE_SITTER_CLI, ...(entry.patches ? { patched: Object.keys(entry.patches) } : {}) }), sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
    raw += bytes.length;
    packed += compressed.length;
    console.log(`${name.padEnd(24)} ${spec}`);
  }
  writeFileSync(join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  rmSync(target, { recursive: true, force: true });
  renameSync(staging, target);
  console.log(`Vendored ${Object.keys(GRAMMARS).length} grammars: ${(raw / 1e6).toFixed(1)} MB -> ${(packed / 1e6).toFixed(1)} MB`);
} finally {
  rmSync(work, { recursive: true, force: true });
  rmSync(staging, { recursive: true, force: true });
}
