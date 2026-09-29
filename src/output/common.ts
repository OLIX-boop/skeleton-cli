import type { PackedFile, PackResult } from '../pack.js';

/** Short per-file annotation used in trees and headings. */
export function fileNote(file: PackedFile): string | undefined {
  if (file.focused) return '[focus]';
  if (file.strategy === 'truncated') return '[truncated]';
  if (file.strategy === 'omitted') return '[omitted]';
  if (file.strategy === 'outline') return '[outline]';
  if (file.strategy === 'full' && file.language) return '[full]';
  return undefined;
}

export function treeNotes(result: PackResult): Map<string, string> {
  const notes = new Map<string, string>();
  for (const file of result.files) {
    const note = fileNote(file);
    if (note) notes.set(file.path, note);
  }
  return notes;
}

/** One-paragraph explanation of the packaging, so the reading model knows what it is looking at. */
export function legend(result: PackResult): string {
  const hasSkeleton = result.files.some((f) => f.strategy === 'skeleton');
  const hasFocus = result.files.some((f) => f.focused);
  const hasTruncated = result.files.some((f) => f.strategy === 'truncated');
  const hasOmitted = result.files.some((f) => f.strategy === 'omitted');
  const hasOutline = result.files.some((f) => f.strategy === 'outline');
  const hasStrippedComments = result.files.some((f) => f.strippedComments > 0);
  const parts: string[] = [];
  if (hasOutline) {
    parts.push('Files marked [outline] list only their declarations and signatures, one per line, with members indented under their class or module.');
  }
  if (hasSkeleton) {
    parts.push(
      `Source files are shown in skeleton form: function and method bodies were replaced with \`...\` placeholders, while imports, types, signatures and class members are intact${hasStrippedComments ? '' : ', as are comments'}.`,
    );
  } else if (!hasOutline) {
    parts.push('All files are included as full source.');
  }
  if (hasStrippedComments) parts.push('Some comments were removed to save space.');
  if (hasFocus) parts.push('Files marked [focus] are included as complete, unmodified source.');
  if (hasTruncated) parts.push('Files marked [truncated] were cut at a size limit.');
  if (hasOmitted) parts.push('Files marked [omitted] exist but were left out to fit a token budget.');
  return parts.join(' ');
}

/** Files whose content appears in the document (omitted files are only listed in the tree). */
export function contentFiles(result: PackResult): PackedFile[] {
  return result.files.filter((f) => f.strategy !== 'omitted');
}

/** Choose a Markdown code fence longer than any backtick run inside `content`. */
export function codeFence(content: string): string {
  let longest = 0;
  const runs = content.match(/`+/g);
  if (runs) for (const run of runs) longest = Math.max(longest, run.length);
  return '`'.repeat(Math.max(3, longest + 1));
}

export function ensureTrailingNewline(text: string): string {
  return text.endsWith('\n') || text === '' ? text : `${text}\n`;
}
