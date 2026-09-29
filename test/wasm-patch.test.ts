/// <reference lib="dom" />
import { describe, expect, it } from 'vitest';
import { IMPORT_RENAMES, renameImports } from '../src/engine/wasm-patch.js';

/** A minimal module importing `env.<name>` as a `() -> ()` function (and a memory). */
function moduleImporting(name: string): Uint8Array {
  const enc = new TextEncoder();
  const str = (s: string) => [s.length, ...enc.encode(s)];
  const imports = [
    0x02, // two imports
    ...str('env'), ...str(name), 0x00, 0x00, // func, type 0
    ...str('env'), ...str('memory'), 0x02, 0x00, 0x01, // memory, min 1
  ];
  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    0x01, 0x04, 0x01, 0x60, 0x00, 0x00, // type section: () -> ()
    0x02, imports.length, ...imports,
  ]);
}

function functionImports(bytes: Uint8Array): string[] {
  return WebAssembly.Module.imports(new WebAssembly.Module(bytes as Uint8Array<ArrayBuffer>))
    .filter((i) => i.kind === 'function')
    .map((i) => i.name);
}

describe('renameImports', () => {
  it('renames libc imports the runtime lacks and keeps the module valid', () => {
    const bytes = moduleImporting('isalpha');
    expect(functionImports(bytes)).toEqual(['isalpha']);
    const patched = renameImports(bytes, IMPORT_RENAMES);
    expect(functionImports(patched)).toEqual(['iswalpha']);
    expect(WebAssembly.validate(patched as Uint8Array<ArrayBuffer>)).toBe(true);
    // Other imports are untouched.
    expect(WebAssembly.Module.imports(new WebAssembly.Module(patched as Uint8Array<ArrayBuffer>)).map((i) => i.name)).toEqual(['iswalpha', 'memory']);
  });

  it('returns the input unchanged when nothing matches', () => {
    const bytes = moduleImporting('iswalpha');
    expect(renameImports(bytes, IMPORT_RENAMES)).toBe(bytes);
    const notWasm = new Uint8Array([1, 2, 3]);
    expect(renameImports(notWasm, IMPORT_RENAMES)).toBe(notWasm);
  });
});
