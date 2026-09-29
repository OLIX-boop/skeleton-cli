import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IMPORT_RENAMES, renameImports } from '../src/engine/wasm-patch.js';
import { skeletonize } from '../src/index.js';

const require = createRequire(import.meta.url);
const grammar = (name: string) => join(dirname(require.resolve('tree-sitter-wasms/package.json')), 'out', `tree-sitter-${name}.wasm`);

function functionImports(bytes: Uint8Array): string[] {
  return WebAssembly.Module.imports(new WebAssembly.Module(bytes))
    .filter((i) => i.kind === 'function')
    .map((i) => i.name);
}

describe('renameImports', () => {
  it('renames libc imports the runtime lacks and keeps the module valid', async () => {
    const bytes = new Uint8Array(await readFile(grammar('bash')));
    expect(functionImports(bytes)).toContain('isalpha');
    const patched = renameImports(bytes, IMPORT_RENAMES);
    const imports = functionImports(patched);
    expect(imports).not.toContain('isalpha');
    expect(imports).toContain('iswalpha');
    expect(WebAssembly.validate(patched)).toBe(true);
  });

  it('returns the input unchanged when nothing matches', async () => {
    const bytes = new Uint8Array(await readFile(grammar('go')));
    expect(renameImports(bytes, { nothing_like_this: 'x' })).toBe(bytes);
    const notWasm = new Uint8Array([1, 2, 3]);
    expect(renameImports(notWasm, IMPORT_RENAMES)).toBe(notWasm);
  });

  it('lets the Bash scanner handle heredocs and regex tests', async () => {
    const src = 'f() {\n  cat <<EOF\nhello\nEOF\n}\nif [[ $x =~ ^[a-z]+$ ]]; then g; fi\n';
    const out = await skeletonize(src, 'bash');
    expect(out.hasErrors).toBe(false);
    expect(out.code).toBe("f() { : '...'; }\nif [[ $x =~ ^[a-z]+$ ]]; then g; fi\n");
  });
});
