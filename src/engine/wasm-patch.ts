/**
 * Minimal WebAssembly binary rewriting: rename function imports.
 *
 * The prebuilt grammars in `tree-sitter-wasms` were linked against an older Emscripten and
 * import a few libc symbols that the current web-tree-sitter runtime no longer exports
 * (e.g. Bash's scanner imports `isalpha`). Renaming such imports to equivalents the runtime
 * does export (`iswalpha`) lets the grammars work unchanged.
 */

function readLeb(bytes: Uint8Array, offset: number): [value: number, next: number] {
  let result = 0;
  let shift = 0;
  let pos = offset;
  for (;;) {
    const byte = bytes[pos++]!;
    result += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return [result, pos];
    shift += 7;
  }
}

function writeLeb(value: number): number[] {
  const out: number[] = [];
  do {
    let byte = value & 0x7f;
    value = Math.floor(value / 128);
    if (value !== 0) byte |= 0x80;
    out.push(byte);
  } while (value !== 0);
  return out;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function skipLimits(bytes: Uint8Array, pos: number): number {
  const flags = bytes[pos++]!;
  [, pos] = readLeb(bytes, pos);
  if (flags & 1) [, pos] = readLeb(bytes, pos);
  return pos;
}

/** Return a copy of `wasm` with function imports renamed per `renames`, or `wasm` itself if none match. */
export function renameImports(wasm: Uint8Array, renames: Readonly<Record<string, string>>): Uint8Array {
  if (wasm.length < 8 || wasm[0] !== 0x00 || wasm[1] !== 0x61 || wasm[2] !== 0x73 || wasm[3] !== 0x6d) return wasm;
  let pos = 8;
  while (pos < wasm.length) {
    const id = wasm[pos]!;
    const [size, contentStart] = readLeb(wasm, pos + 1);
    const contentEnd = contentStart + size;
    if (id !== 2) {
      pos = contentEnd;
      continue;
    }

    // Import section: rebuild it with renamed entries.
    let p = contentStart;
    const [count, afterCount] = readLeb(wasm, p);
    p = afterCount;
    const out: number[] = [...writeLeb(count)];
    let changed = false;
    for (let i = 0; i < count; i++) {
      const [modLen, modStart] = readLeb(wasm, p);
      const modEnd = modStart + modLen;
      const [fieldLen, fieldStart] = readLeb(wasm, modEnd);
      const fieldEnd = fieldStart + fieldLen;
      const kind = wasm[fieldEnd]!;
      let descEnd = fieldEnd + 1;
      if (kind === 0) [, descEnd] = readLeb(wasm, descEnd);
      else if (kind === 1) descEnd = skipLimits(wasm, descEnd + 1);
      else if (kind === 2) descEnd = skipLimits(wasm, descEnd);
      else if (kind === 3) descEnd += 2;
      else return wasm; // unknown import kind (e.g. tags): leave the module alone

      const field = decoder.decode(wasm.subarray(fieldStart, fieldEnd));
      const renamed = kind === 0 ? renames[field] : undefined;
      out.push(...wasm.subarray(p, modEnd));
      if (renamed) {
        const name = encoder.encode(renamed);
        out.push(...writeLeb(name.length), ...name);
        changed = true;
      } else {
        out.push(...wasm.subarray(modEnd, fieldEnd));
      }
      out.push(...wasm.subarray(fieldEnd, descEnd));
      p = descEnd;
    }
    if (!changed) return wasm;
    const section = [id, ...writeLeb(out.length), ...out];
    const result = new Uint8Array(pos + section.length + (wasm.length - contentEnd));
    result.set(wasm.subarray(0, pos), 0);
    result.set(section, pos);
    result.set(wasm.subarray(contentEnd), pos + section.length);
    return result;
  }
  return wasm;
}

/** libc symbols imported by old grammars, mapped to equivalents the runtime exports. */
export const IMPORT_RENAMES: Readonly<Record<string, string>> = {
  isalpha: 'iswalpha',
  isalnum: 'iswalnum',
  isspace: 'iswspace',
  isdigit: 'iswdigit',
  isupper: 'iswupper',
  islower: 'iswlower',
  toupper: 'towupper',
  tolower: 'towlower',
};
