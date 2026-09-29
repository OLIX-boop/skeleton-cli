import { renderTree } from './tree.js';
import { ensureTrailingNewline, codeFence, fileNote, legend, treeNotes } from './common.js';
import type { Renderer } from './types.js';

export const renderMarkdown: Renderer = (result, options) => {
  const out: string[] = [];
  out.push(`# ${options.projectName}`, '');

  const meta = [`mode: ${result.mode}`, `${result.files.length} files`];
  if (options.focus?.length) meta.push(`focus: ${options.focus.join(', ')}`);
  out.push(`> Packed by astpack${options.version ? ` v${options.version}` : ''} · ${meta.join(' · ')}`, '>', `> ${legend(result)}`, '');

  if (options.instructions?.trim()) {
    out.push('## Instructions', '', options.instructions.trim(), '');
  }

  if (options.tree !== false) {
    const tree = renderTree(result.files.map((f) => f.path), treeNotes(result));
    out.push('## Directory structure', '', '```text', tree, '```', '');
  }

  out.push('## Files', '');
  for (const file of result.files) {
    const note = fileNote(file);
    const fence = codeFence(file.content);
    out.push(`### \`${file.path}\`${note ? ` ${note}` : ''}`, '');
    out.push(`${fence}${file.fence}`, ensureTrailingNewline(file.content) + fence, '');
  }
  return `${out.join('\n').trimEnd()}\n`;
};
