import { renderGraph } from '../deps.js';
import { renderTree } from './tree.js';
import { contentFiles, ensureTrailingNewline, codeFence, fileNote, legend, treeNotes } from './common.js';
import type { Renderer } from './types.js';

export const renderMarkdown: Renderer = (result, options) => {
  const out: string[] = [];
  const part = options.part;
  const first = !part || part.index === 1;
  const whole = part ? { ...result, files: [...part.allFiles] } : result;
  out.push(`# ${options.projectName}${part ? ` (part ${part.index} of ${part.total})` : ''}`, '');

  const meta = [`mode: ${result.mode}`, part ? `${result.files.length} of ${part.allFiles.length} files` : `${result.files.length} files`];
  if (options.focus?.length) meta.push(`focus: ${options.focus.join(', ')}`);
  out.push(`> Packed by astpack${options.version ? ` v${options.version}` : ''} · ${meta.join(' · ')}`, '>', `> ${legend(whole)}`);
  if (part && !first) out.push('>', `> This is part ${part.index} of ${part.total}; the directory structure is in part 1.`);
  out.push('');

  if (first && options.instructions?.trim()) {
    out.push('## Instructions', '', options.instructions.trim(), '');
  }

  if (first && options.tree !== false) {
    const tree = renderTree(whole.files.map((f) => f.path), treeNotes(whole));
    out.push('## Directory structure', '', '```text', tree, '```', '');
  }

  if (first && options.dependencies?.size) {
    out.push(
      '## Dependencies',
      '',
      'Internal imports, one line per file: `file -> files it imports`.',
      '',
      '```text',
      renderGraph(options.dependencies, whole.files),
      '```',
      '',
    );
  }

  const diff = () => {
    if (!first || !options.diff?.text.trim()) return;
    const fence = codeFence(options.diff.text);
    out.push(`## Git diff (vs \`${options.diff.ref}\`)`, '', `${fence}diff`, ensureTrailingNewline(options.diff.text) + fence, '');
  };
  if (!options.diffLast) diff();

  out.push('## Files', '');
  for (const file of contentFiles(result)) {
    const note = fileNote(file);
    const fence = codeFence(file.content);
    out.push(`### \`${file.path}\`${note ? ` ${note}` : ''}`, '');
    out.push(`${fence}${file.fence}`, ensureTrailingNewline(file.content) + fence, '');
  }
  if (options.diffLast) diff();
  return `${out.join('\n').trimEnd()}\n`;
};
