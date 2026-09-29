// Copies the Tree-sitter grammars astpack uses into grammars/ as brotli-compressed WASM
// (~31 MB -> ~2 MB), so the published package does not depend on tree-sitter-wasms.
// Run after `tsc` (it reads the grammar list from dist/).
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { brotliCompressSync, constants } from 'node:zlib';
import { LANGUAGES } from '../dist/languages/index.js';

const require = createRequire(import.meta.url);
const source = join(dirname(require.resolve('tree-sitter-wasms/package.json')), 'out');
const target = new URL('../grammars/', import.meta.url);

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });

let raw = 0;
let packed = 0;
for (const grammar of new Set(Object.values(LANGUAGES).map((l) => l.grammar))) {
  const bytes = readFileSync(join(source, `${grammar}.wasm`));
  const compressed = brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } });
  writeFileSync(new URL(`${grammar}.wasm.br`, target), compressed);
  raw += bytes.length;
  packed += compressed.length;
}
console.log(`Vendored grammars: ${(raw / 1e6).toFixed(1)} MB -> ${(packed / 1e6).toFixed(1)} MB`);
