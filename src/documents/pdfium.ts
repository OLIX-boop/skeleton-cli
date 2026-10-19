import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { WrappedPdfiumModule } from '@embedpdf/pdfium';
import { DocumentError } from './common.js';

/**
 * PDFium (the PDF engine in Chrome) compiled to WebAssembly, loaded on first use. One
 * instance serves the process; documents are opened from memory and always closed.
 */

let loading: Promise<WrappedPdfiumModule> | undefined;

export function pdfium(): Promise<WrappedPdfiumModule> {
  loading ??= (async () => {
    const { init } = await import('@embedpdf/pdfium');
    const wasm = await readFile(createRequire(import.meta.url).resolve('@embedpdf/pdfium/pdfium.wasm'));
    const module = await init({ wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer });
    module.PDFiumExt_Init();
    return module;
  })();
  return loading;
}

const LOAD_ERRORS: Record<number, string> = {
  2: 'file not found or could not be opened',
  3: 'not a PDF or corrupted',
  4: 'password-protected',
  5: 'unsupported security scheme',
  6: 'page error',
};

/** The WASM heap as bytes. Read it fresh each time: it is replaced when memory grows. */
export function heapBytes(m: WrappedPdfiumModule): Uint8Array {
  return (m.pdfium as unknown as { HEAPU8: Uint8Array }).HEAPU8;
}

/** Open `bytes` as a PDF, run `fn`, and release everything. */
export async function withPdf<T>(bytes: Uint8Array, fn: (m: WrappedPdfiumModule, doc: number) => T): Promise<T> {
  const m = await pdfium();
  const heap = m.pdfium;
  const ptr = heap.wasmExports.malloc(bytes.length);
  heapBytes(m).set(bytes, ptr);
  const doc = m.FPDF_LoadMemDocument(ptr, bytes.length, '');
  if (!doc) {
    const code = m.FPDF_GetLastError();
    heap.wasmExports.free(ptr);
    throw new DocumentError(`cannot open PDF: ${LOAD_ERRORS[code] ?? `error ${code}`}`);
  }
  try {
    return fn(m, doc);
  } finally {
    m.FPDF_CloseDocument(doc);
    heap.wasmExports.free(ptr);
  }
}

/** Run `fn` with a scratch buffer of `size` bytes on the WASM heap. */
export function withScratch<T>(m: WrappedPdfiumModule, size: number, fn: (ptr: number) => T): T {
  const ptr = m.pdfium.wasmExports.malloc(size);
  try {
    return fn(ptr);
  } finally {
    m.pdfium.wasmExports.free(ptr);
  }
}
