import { formatBytes, joinBlocks, type ConvertedDocument } from './common.js';
import { htmlToMarkdown } from './html.js';

/**
 * E-mail messages (`.eml`, RFC 822/MIME): the main headers, the text body (plain text
 * preferred, else HTML converted), and a list of attachments. Quoted replies are kept.
 */

interface Part {
  headers: Map<string, string>;
  body: Uint8Array;
}

function decodeText(bytes: Uint8Array, charset = 'utf-8'): string {
  try {
    return new TextDecoder(charset.toLowerCase().replace(/^"|"$/g, '')).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/** RFC 2047 encoded words in headers: `=?utf-8?B?...?=` and `=?iso-8859-1?Q?...?=`. */
export function decodeHeader(value: string): string {
  return value
    .replace(/\?=\s+=\?/g, '?==?')
    .replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (_, charset: string, encoding: string, text: string) => {
      const bytes = encoding.toLowerCase() === 'b' ? Buffer.from(text, 'base64') : quotedPrintable(text.replace(/_/g, ' '));
      return decodeText(bytes, charset);
    });
}

function quotedPrintable(text: string): Uint8Array {
  const bytes: number[] = [];
  const source = text.replace(/=\r?\n/g, '');
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (c === '=' && /^[0-9a-f]{2}$/i.test(source.slice(i + 1, i + 3))) {
      bytes.push(parseInt(source.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      // Keep any non-ASCII as UTF-8 (lenient: the part should have been encoded).
      bytes.push(...Buffer.from(c, 'utf8'));
    }
  }
  return Uint8Array.from(bytes);
}

function parsePart(bytes: Uint8Array): Part {
  const raw = Buffer.from(bytes);
  let split = raw.indexOf('\r\n\r\n');
  let gap = 4;
  const lf = raw.indexOf('\n\n');
  if (split === -1 || (lf !== -1 && lf < split)) {
    split = lf;
    gap = 2;
  }
  const head = split === -1 ? raw.toString('latin1') : raw.subarray(0, split).toString('latin1');
  const headers = new Map<string, string>();
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  return { headers, body: split === -1 ? new Uint8Array() : raw.subarray(split + gap) };
}

function param(header: string | undefined, name: string): string | undefined {
  const m = new RegExp(`${name}\\*?=\\s*(?:"([^"]*)"|([^;\\s]+))`, 'i').exec(header ?? '');
  return m ? (m[1] ?? m[2]) : undefined;
}

function decodedBody(part: Part): Uint8Array {
  const encoding = (part.headers.get('content-transfer-encoding') ?? '').toLowerCase();
  if (encoding === 'base64') return Buffer.from(Buffer.from(part.body).toString('latin1').replace(/\s+/g, ''), 'base64');
  if (encoding === 'quoted-printable') return quotedPrintable(Buffer.from(part.body).toString('latin1'));
  return part.body;
}

interface Collected {
  plain: string[];
  html: string[];
  attachments: string[];
}

function collect(part: Part, out: Collected, depth = 0): void {
  const type = (part.headers.get('content-type') ?? 'text/plain').toLowerCase();
  const disposition = part.headers.get('content-disposition') ?? '';
  const filename = param(disposition, 'filename') ?? param(part.headers.get('content-type'), 'name');
  if (type.startsWith('multipart/') && depth < 10) {
    const boundary = param(part.headers.get('content-type'), 'boundary');
    if (!boundary) return;
    const body = Buffer.from(part.body).toString('latin1');
    const pieces = body.split(`--${boundary}`).slice(1);
    const alternatives: Collected[] = [];
    for (const piece of pieces) {
      if (piece.startsWith('--')) break;
      const sub = parsePart(Buffer.from(piece.replace(/^\r?\n/, ''), 'latin1'));
      if (type.startsWith('multipart/alternative')) {
        const alt: Collected = { plain: [], html: [], attachments: [] };
        collect(sub, alt, depth + 1);
        alternatives.push(alt);
      } else {
        collect(sub, out, depth + 1);
      }
    }
    // Of the alternatives, plain text is the cheapest faithful one.
    const best = alternatives.find((a) => a.plain.length) ?? alternatives.find((a) => a.html.length);
    if (best) {
      out.plain.push(...best.plain);
      out.html.push(...best.html);
    }
    for (const alt of alternatives) out.attachments.push(...alt.attachments);
    return;
  }
  const body = decodedBody(part);
  if (/^attachment/i.test(disposition) || (filename && !type.startsWith('text/'))) {
    out.attachments.push(`[attachment: ${decodeHeader(filename ?? 'unnamed')}, ${formatBytes(body.length)}]`);
    return;
  }
  if (type.startsWith('message/rfc822')) {
    out.plain.push(convertEml(body).markdown);
    return;
  }
  const text = decodeText(body, param(part.headers.get('content-type'), 'charset'));
  if (type.startsWith('text/html')) out.html.push(text);
  else if (type.startsWith('text/')) out.plain.push(text);
}

export function convertEml(bytes: Uint8Array): ConvertedDocument {
  const message = parsePart(bytes);
  const collected: Collected = { plain: [], html: [], attachments: [] };
  collect(message, collected);
  const header = ['from', 'to', 'cc', 'date']
    .filter((h) => message.headers.has(h))
    .map((h) => `**${h[0]!.toUpperCase()}${h.slice(1)}:** ${decodeHeader(message.headers.get(h)!)}`)
    .join('  \n');
  const subject = decodeHeader(message.headers.get('subject') ?? '').trim();
  const body = collected.plain.length
    ? collected.plain.map((t) => t.replace(/\r\n/g, '\n').trim()).join('\n\n')
    : collected.html.map((h) => htmlToMarkdown(h)).join('\n\n');
  return {
    markdown: joinBlocks([subject ? `# ${subject}` : '', header, body, collected.attachments.join('\n')]),
    format: 'eml',
  };
}
