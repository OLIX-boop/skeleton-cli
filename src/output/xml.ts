import { renderGraph } from '../deps.js';
import { renderTree } from './tree.js';
import { contentFiles, ensureTrailingNewline, legend, treeNotes } from './common.js';
import type { Renderer } from './types.js';

function attr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * XML-tagged output in the style LLMs handle well (e.g. Claude's long-context guidance).
 * File contents are *not* escaped: the goal is readability for a model, not a strict parser.
 */
export const renderXml: Renderer = (result, options) => {
  const out: string[] = [];
  const part = options.part;
  const first = !part || part.index === 1;
  const whole = part ? { ...result, files: [...part.allFiles] } : result;
  const focus = options.focus?.length ? ` focus="${attr(options.focus.join(','))}"` : '';
  const partAttr = part ? ` part="${part.index}" parts="${part.total}"` : '';
  out.push(`<project name="${attr(options.projectName)}" mode="${result.mode}" files="${whole.files.length}"${partAttr}${focus}>`);
  out.push(`<notes>${legend(whole)}${part && !first ? ` This is part ${part.index} of ${part.total}; the directory structure is in part 1.` : ''}</notes>`);
  if (first && options.instructions?.trim()) out.push('<instructions>', options.instructions.trim(), '</instructions>');
  if (first && options.tree !== false) {
    out.push('<directory_structure>', renderTree(whole.files.map((f) => f.path), treeNotes(whole)), '</directory_structure>');
  }
  if (first && options.dependencies?.size) {
    out.push('<dependencies>', renderGraph(options.dependencies, whole.files), '</dependencies>');
  }
  if (first && options.diff?.text.trim()) {
    out.push(`<git_diff ref="${attr(options.diff.ref)}">`, ensureTrailingNewline(options.diff.text) + '</git_diff>');
  }
  out.push('<files>');
  for (const file of contentFiles(result)) {
    const attrs = [`path="${attr(file.path)}"`];
    if (file.language) attrs.push(`language="${file.language}"`);
    attrs.push(`strategy="${file.strategy}"`);
    if (file.focused) attrs.push('focus="true"');
    out.push(`<file ${attrs.join(' ')}>`, ensureTrailingNewline(file.content) + '</file>');
  }
  out.push('</files>', '</project>');
  return `${out.join('\n')}\n`;
};
