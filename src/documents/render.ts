import { crc32, deflateSync } from 'node:zlib';
import { DocumentError } from './common.js';
import { heapBytes, withPdf } from './pdfium.js';

/**
 * Render PDF pages as compact images for a vision model: grayscale, cropped to the content
 * (with isolated specks such as a page number at the bottom ignored), and scaled so the
 * image stays within what Claude takes without downscaling. Image tokens grow with pixel
 * area (about width × height / 750), so the crop is where the saving comes from.
 */

export interface RenderedPage {
  page: number;
  /** PNG bytes. */
  png: Uint8Array;
  width: number;
  height: number;
  /** Estimated Claude image tokens (width × height / 750). */
  tokens: number;
  /** Share of the full page area the crop kept. */
  kept: number;
}

export interface RenderOptions {
  /** Pixels across the page's width before cropping (default 1100: legible handwriting). */
  width?: number;
  /** Longest image edge (default 1568, Claude's limit before it resizes). */
  maxEdge?: number;
  /** Largest image area in pixels (default 1.15 MP, about 1,500 tokens). */
  maxPixels?: number;
}

/** Luminance below this counts as ink. */
const INK = 225;

function encodePng(gray: Uint8Array, width: number, height: number): Uint8Array {
  // Filter each row with "Up" (byte minus the byte above): text and strokes compress far better.
  const raw = new Uint8Array((width + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width + 1);
    raw[row] = 2;
    for (let x = 0; x < width; x++) {
      const v = gray[y * width + x]!;
      raw[row + 1 + x] = (v - (y ? gray[(y - 1) * width + x]! : 0)) & 0xff;
    }
  }
  const chunk = (type: string, data: Uint8Array) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'latin1');
    out.set(data, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 0; // grayscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array()),
  ]);
}

/** Runs of indices whose `hasInk` is true, merged across gaps up to `bridge`. */
function runs(length: number, hasInk: (i: number) => boolean, bridge: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < length; i++) {
    if (!hasInk(i)) continue;
    const last = out[out.length - 1];
    if (last && i - last[1] <= bridge) last[1] = i;
    else out.push([i, i]);
  }
  return out;
}

/**
 * The content box: ink rows and columns, dropping small isolated runs at the edges (a page
 * number, a stray mark) when they sit far from everything else.
 */
export function contentBox(gray: Uint8Array, width: number, height: number): { x0: number; y0: number; x1: number; y1: number } | undefined {
  const rowInk = new Uint32Array(height);
  const colInk = new Uint32Array(width);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (gray[y * width + x]! < INK) {
        rowInk[y]!++;
        colInk[x]!++;
      }
    }
  }
  const trim = (spans: [number, number][], size: number) => {
    const span = (s: [number, number]) => s[1] - s[0] + 1;
    while (spans.length > 1) {
      const first = spans[0]!;
      const last = spans[spans.length - 1]!;
      const firstGap = spans[1]![0] - first[1];
      const lastGap = last[0] - spans[spans.length - 2]![1];
      if (span(first) < size * 0.03 && firstGap > size * 0.08) spans.shift();
      else if (span(last) < size * 0.03 && lastGap > size * 0.08) spans.pop();
      else break;
    }
    return spans;
  };
  const rows = trim(runs(height, (y) => rowInk[y]! > 0, Math.round(height * 0.02)), height);
  const cols = trim(runs(width, (x) => colInk[x]! > 0, Math.round(width * 0.02)), width);
  if (!rows.length || !cols.length) return undefined;
  const pad = Math.round(Math.min(width, height) * 0.015);
  return {
    x0: Math.max(0, cols[0]![0] - pad),
    y0: Math.max(0, rows[0]![0] - pad),
    x1: Math.min(width - 1, cols[cols.length - 1]![1] + pad),
    y1: Math.min(height - 1, rows[rows.length - 1]![1] + pad),
  };
}

/** Nearest-neighbour would lose thin strokes: average the source pixels each output pixel covers. */
function downscale(gray: Uint8Array, width: number, height: number, factor: number) {
  const w = Math.max(1, Math.round(width * factor));
  const h = Math.max(1, Math.round(height * factor));
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy0 = Math.floor(y / factor);
    const sy1 = Math.min(height, Math.max(sy0 + 1, Math.floor((y + 1) / factor)));
    for (let x = 0; x < w; x++) {
      const sx0 = Math.floor(x / factor);
      const sx1 = Math.min(width, Math.max(sx0 + 1, Math.floor((x + 1) / factor)));
      let sum = 0;
      for (let sy = sy0; sy < sy1; sy++) for (let sx = sx0; sx < sx1; sx++) sum += gray[sy * width + sx]!;
      out[y * w + x] = sum / ((sy1 - sy0) * (sx1 - sx0));
    }
  }
  return { gray: out, width: w, height: h };
}

// PDFium bitmap formats and render flags.
const BITMAP_GRAY = 1;
const RENDER_ANNOTATIONS = 0x01;
const RENDER_GRAYSCALE = 0x08;

/** Render the given 1-based pages. Blank pages are left out of the result. */
export async function renderPdfPages(bytes: Uint8Array, pages: readonly number[], options: RenderOptions = {}): Promise<RenderedPage[]> {
  const targetWidth = options.width ?? 1100;
  const maxEdge = options.maxEdge ?? 1568;
  const maxPixels = options.maxPixels ?? 1_150_000;
  return withPdf(bytes, (m, doc) => {
    const count = m.FPDF_GetPageCount(doc);
    const out: RenderedPage[] = [];
    for (const number of pages) {
      if (!Number.isInteger(number) || number < 1 || number > count) throw new DocumentError(`page ${number} does not exist (the document has ${count})`);
      const page = m.FPDF_LoadPage(doc, number - 1);
      if (!page) continue;
      let bitmap = 0;
      try {
        const pw = m.FPDF_GetPageWidthF(page);
        const ph = m.FPDF_GetPageHeightF(page);
        const scale = Math.min(targetWidth / Math.min(pw, ph), maxEdge / Math.max(pw, ph));
        const width = Math.max(1, Math.round(pw * scale));
        const height = Math.max(1, Math.round(ph * scale));
        bitmap = m.FPDFBitmap_CreateEx(width, height, BITMAP_GRAY, 0, 0);
        if (!bitmap) throw new DocumentError('out of memory rendering a page');
        m.FPDFBitmap_FillRect(bitmap, 0, 0, width, height, 0xffffffff);
        m.FPDF_RenderPageBitmap(bitmap, page, 0, 0, width, height, 0, RENDER_ANNOTATIONS | RENDER_GRAYSCALE);
        const buffer = m.FPDFBitmap_GetBuffer(bitmap);
        const stride = m.FPDFBitmap_GetStride(bitmap);
        const heap = heapBytes(m);
        const gray = new Uint8Array(width * height);
        for (let y = 0; y < height; y++) gray.set(heap.subarray(buffer + y * stride, buffer + y * stride + width), y * width);
        const box = contentBox(gray, width, height);
        if (!box) continue;
        const cw = box.x1 - box.x0 + 1;
        const ch = box.y1 - box.y0 + 1;
        // A speck on an otherwise empty page.
        if (cw * ch < width * height * 0.005) continue;
        const cropped = new Uint8Array(cw * ch);
        for (let y = 0; y < ch; y++) cropped.set(gray.subarray((box.y0 + y) * width + box.x0, (box.y0 + y) * width + box.x0 + cw), y * cw);
        let image = { gray: cropped, width: cw, height: ch };
        const factor = Math.min(1, Math.sqrt(maxPixels / (cw * ch)), maxEdge / Math.max(cw, ch));
        if (factor < 0.98) image = downscale(cropped, cw, ch, factor);
        out.push({
          page: number,
          png: encodePng(image.gray, image.width, image.height),
          width: image.width,
          height: image.height,
          tokens: Math.ceil((image.width * image.height) / 750),
          kept: (cw * ch) / (width * height),
        });
      } finally {
        if (bitmap) m.FPDFBitmap_Destroy(bitmap);
        m.FPDF_ClosePage(page);
      }
    }
    return out;
  });
}

/** Estimated Claude tokens of a full page image at the default rendering (for comparisons). */
export function fullPageTokens(widthPt: number, heightPt: number): number {
  const scale = Math.min(1568 / Math.max(widthPt, heightPt), Math.sqrt(1_150_000 / (widthPt * heightPt)));
  return Math.ceil((widthPt * scale * heightPt * scale) / 750);
}
