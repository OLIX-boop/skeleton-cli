import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import type { Command } from 'commander';
import { openCache, setCacheStore } from '../cache/store.js';
import { DocumentError, parsePages, renderPdfPages } from '../documents/index.js';
import { readDocument, type ReadMode } from '../documents/read.js';
import { redactSecrets } from '../security/secrets.js';
import { copyToClipboard } from './clipboard.js';
import { makeColors, shouldColor } from './colors.js';
import type { CliIO } from './pack-command.js';

interface DocOptions {
  full?: boolean;
  skeleton?: boolean;
  outline?: boolean;
  section?: string;
  pages?: string;
  images?: string;
  output?: string;
  clipboard?: boolean;
  redact: boolean;
  cache: boolean;
}

/** `astpack doc <files...>`: documents as Markdown, whole or by section, outline or pages. */
export async function docCommand(files: string[], command: Command, io: CliIO): Promise<number> {
  const opts = command.opts<DocOptions>();
  const err = makeColors(shouldColor(process.stderr as NodeJS.WriteStream));
  const mode: ReadMode = opts.full ? 'full' : opts.skeleton ? 'skeleton' : opts.outline ? 'outline' : 'auto';
  let pages: number[] | undefined;
  try {
    pages = opts.pages ? parsePages(opts.pages) : undefined;
  } catch (error) {
    io.stderr.write(`${err.red('error:')} ${(error as Error).message}\n`);
    return 1;
  }
  // A cache file of its own: saving keeps only the entries this run used, so sharing the
  // project's pack cache would empty it.
  const cache = opts.cache ? openCache(`doc:${resolve(io.cwd)}`) : undefined;
  setCacheStore(cache);
  const outputs: string[] = [];
  let failed = false;
  try {
    for (const file of files) {
      const abs = resolve(io.cwd, file);
      try {
        const result = await readDocument(abs, { mode, section: opts.section, pages });
        let text = result.text;
        if (opts.redact) text = redactSecrets(text).content;
        outputs.push(files.length > 1 ? `## ${file}\n\n${text}` : text);
        if (result.pending.length && opts.images) {
          const dir = resolve(io.cwd, opts.images);
          await mkdir(dir, { recursive: true });
          const rendered = await renderPdfPages(result.document.bytes, result.pending.map((v) => v.page));
          for (const page of rendered) {
            const out = join(dir, `${basename(file).replace(/\.[^.]+$/, '')}-p${page.page}.png`);
            await writeFile(out, page.png);
            io.stderr.write(`${err.dim(`page ${page.page} → ${out} (${page.width}×${page.height}, ~${page.tokens} image tokens)`)}\n`);
          }
        } else if (result.pending.length) {
          io.stderr.write(`${err.yellow('note:')} ${file}: page${result.pending.length === 1 ? '' : 's'} ${result.pending.map((v) => v.page).join(', ')} hold handwriting or images; --images <dir> saves them as compact PNGs\n`);
        }
        io.stderr.write(`${err.dim(`${file}: ${result.view}, ${result.tokens.toLocaleString('en-US')} tokens (the full text is ${result.documentTokens.toLocaleString('en-US')})`)}\n`);
      } catch (error) {
        failed = true;
        const message = error instanceof DocumentError || (error as NodeJS.ErrnoException).code === 'ENOENT' ? (error as Error).message : String(error);
        io.stderr.write(`${err.red('error:')} ${file}: ${message}\n`);
      }
    }
  } finally {
    cache?.save();
    setCacheStore(undefined);
  }
  const document = outputs.join('\n\n');
  if (document) {
    if (opts.output) {
      await writeFile(resolve(io.cwd, opts.output), document);
      io.stderr.write(`${err.dim(`wrote ${opts.output}`)}\n`);
    } else if (opts.clipboard) {
      const tool = await copyToClipboard(document);
      io.stderr.write(`${err.dim(`copied to the clipboard (${tool})`)}\n`);
    } else {
      io.stdout.write(document.endsWith('\n') ? document : `${document}\n`);
    }
  }
  return failed ? 1 : 0;
}
