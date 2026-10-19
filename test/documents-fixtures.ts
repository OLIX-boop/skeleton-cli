import { strToU8, zipSync } from 'fflate';

/** Build test documents in memory: ZIP containers (Office, OpenDocument, EPUB) and minimal PDFs. */

export function zip(files: Record<string, string>): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])));
}

export interface PdfPage {
  /** The page's content stream (PDF drawing operators). */
  content: string;
  /** Draw a 40×40 gray image named /Im1 available to the content stream. */
  image?: boolean;
}

/** A text line in Helvetica at (x, y) from the bottom-left corner, in points. */
export function text(x: number, y: number, size: number, value: string): string {
  const escaped = value.replace(/[\\()]/g, (c) => `\\${c}`);
  return `BT /F1 ${size} Tf ${x} ${y} Td (${escaped}) Tj ET\n`;
}

/** Wavy pen strokes, like handwriting exported as vector ink. */
export function ink(strokes: number, x = 80, y = 600): string {
  let out = '1.5 w\n';
  for (let i = 0; i < strokes; i++) {
    const sx = x + (i % 6) * 70;
    const sy = y - Math.floor(i / 6) * 40;
    out += `${sx} ${sy} m ${sx + 10} ${sy + 18} ${sx + 20} ${sy - 18} ${sx + 30} ${sy} c ${sx + 40} ${sy + 18} ${sx + 50} ${sy - 18} ${sx + 60} ${sy} c S\n`;
  }
  return out;
}

/** A minimal, valid PDF (A4 pages, Helvetica) with the given page contents. */
export function pdf(pages: PdfPage[]): Uint8Array {
  const objects: string[] = [];
  const add = (body: string) => {
    objects.push(body);
    return objects.length;
  };
  const catalog = add('');
  const pagesObj = add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const imageData = 'x'.repeat(40 * 40);
  const image = add(`<< /Type /XObject /Subtype /Image /Width 40 /Height 40 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length ${imageData.length} >>\nstream\n${imageData}\nendstream`);
  const kids: number[] = [];
  for (const page of pages) {
    const stream = add(`<< /Length ${Buffer.byteLength(page.content, 'latin1')} >>\nstream\n${page.content}\nendstream`);
    const resources = `<< /Font << /F1 ${font} 0 R >>${page.image ? ` /XObject << /Im1 ${image} 0 R >>` : ''} >>`;
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 595 842] /Resources ${resources} /Contents ${stream} 0 R >>`));
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

export function docx(body: string, extra: Record<string, string> = {}): Uint8Array {
  return zip({
    '[Content_Types].xml': '<Types/>',
    'word/document.xml': `<?xml version="1.0"?><w:document ${W}><w:body>${body}</w:body></w:document>`,
    'word/styles.xml': `<w:styles ${W}>
      <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style>
      <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>
      <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style>
    </w:styles>`,
    'word/numbering.xml': `<w:numbering ${W}>
      <w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>
      <w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>
      <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
      <w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
    </w:numbering>`,
    ...extra,
  });
}

export function para(textValue: string, style?: string, num?: number): string {
  const pPr = style || num ? `<w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${num ? `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${num}"/></w:numPr>` : ''}</w:pPr>` : '';
  return `<w:p>${pPr}<w:r><w:t xml:space="preserve">${textValue}</w:t></w:r></w:p>`;
}
