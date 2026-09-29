import type { LanguageId } from './types.js';

/**
 * Jupyter notebooks (`.ipynb`) are JSON whose outputs (images as base64, tables, logs) often
 * dwarf the code. They are packed as a script in "percent" format — the layout Jupytext,
 * VS Code and Spyder read back as cells: `# %%` before each code cell, `# %% [markdown]`
 * before each markdown cell with its text commented out. Outputs and metadata are dropped.
 */

interface Cell {
  cell_type?: string;
  source?: string | string[];
}

interface Notebook {
  cells?: Cell[];
  metadata?: { kernelspec?: { language?: string }; language_info?: { name?: string } };
}

export const NOTEBOOK_EXTENSION = '.ipynb';

/** Kernel languages astpack can skeletonize, and the comment prefix of each. */
const KERNELS: Record<string, { language?: LanguageId; extension: string; comment: string }> = {
  python: { language: 'python', extension: '.py', comment: '#' },
  julia: { language: 'julia', extension: '.jl', comment: '#' },
  r: { extension: '.r', comment: '#' },
  scala: { language: 'scala', extension: '.scala', comment: '//' },
  typescript: { language: 'typescript', extension: '.ts', comment: '//' },
  javascript: { language: 'javascript', extension: '.js', comment: '//' },
};

export interface NotebookScript {
  /** The notebook as a percent-format script. */
  text: string;
  /** Extension of the kernel language (`.py`, `.jl`…), to pick the parser. */
  extension: string;
  /** Code-fence language. */
  fence: string;
}

export function isNotebook(path: string): boolean {
  return path.toLowerCase().endsWith(NOTEBOOK_EXTENSION);
}

/** IPython magics and shell escapes (`%timeit`, `%%bash`, `!pip install`, `obj?`): not Python. */
const MAGIC = /^\s*(%|!|\?)|^\s*[\w.]+\?{1,2}\s*$/;

/** Comment out magics, as Jupytext does, so the cell parses as Python. */
function commentMagics(code: string): string {
  // A `%%cell` magic makes the whole cell another language.
  if (/^\s*%%/.test(code)) return code.split('\n').map((line) => `# ${line}`.trimEnd()).join('\n');
  return code
    .split('\n')
    .map((line) => (MAGIC.test(line) ? `# ${line}` : line))
    .join('\n');
}

function text(source: Cell['source']): string {
  return (Array.isArray(source) ? source.join('') : (source ?? '')).replace(/\r\n/g, '\n').replace(/\s+$/, '');
}

/** Convert notebook JSON to a percent-format script, or `undefined` if it isn't a notebook. */
export function notebookToScript(json: string): NotebookScript | undefined {
  let notebook: Notebook;
  try {
    notebook = JSON.parse(json) as Notebook;
  } catch {
    return undefined;
  }
  if (!notebook || !Array.isArray(notebook.cells)) return undefined;
  const name = (notebook.metadata?.kernelspec?.language ?? notebook.metadata?.language_info?.name ?? 'python').toLowerCase();
  const kernel = KERNELS[name] ?? { extension: '.txt', comment: '#' };
  const c = kernel.comment;
  const blocks: string[] = [];
  for (const cell of notebook.cells) {
    const body = text(cell.source);
    if (cell.cell_type === 'code') {
      const code = kernel.language === 'python' ? commentMagics(body) : body;
      blocks.push(code ? `${c} %%\n${code}` : `${c} %%`);
    } else if (cell.cell_type === 'markdown' || cell.cell_type === 'raw') {
      const kind = cell.cell_type === 'markdown' ? 'markdown' : 'raw';
      const commented = body ? `\n${body.split('\n').map((line) => (line ? `${c} ${line}` : c)).join('\n')}` : '';
      blocks.push(`${c} %% [${kind}]${commented}`);
    }
  }
  return { text: blocks.length ? `${blocks.join('\n\n')}\n` : '', extension: kernel.extension, fence: kernel.language ?? name };
}
