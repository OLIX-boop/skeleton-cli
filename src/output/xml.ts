import { renderTree } from './tree.js';
import { ensureTrailingNewline, legend, treeNotes } from './common.js';
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
  const focus = options.focus?.length ? ` focus="${attr(options.focus.join(','))}"` : '';
  out.push(`<project name="${attr(options.projectName)}" mode="${result.mode}" files="${result.files.length}"${focus}>`);
  out.push(`<notes>${legend(result)}</notes>`);
  if (options.instructions?.trim()) out.push('<instructions>', options.instructions.trim(), '</instructions>');
  if (options.tree !== false) {
    out.push('<directory_structure>', renderTree(result.files.map((f) => f.path), treeNotes(result)), '</directory_structure>');
  }
  out.push('<files>');
  for (const file of result.files) {
    const attrs = [`path="${attr(file.path)}"`];
    if (file.language) attrs.push(`language="${file.language}"`);
    attrs.push(`strategy="${file.strategy}"`);
    if (file.focused) attrs.push('focus="true"');
    out.push(`<file ${attrs.join(' ')}>`, ensureTrailingNewline(file.content) + '</file>');
  }
  out.push('</files>', '</project>');
  return `${out.join('\n')}\n`;
};
