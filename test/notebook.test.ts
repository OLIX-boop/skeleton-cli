import { describe, expect, it } from 'vitest';
import { transformFile } from '../src/engine/transform.js';
import { notebookToScript } from '../src/languages/notebook.js';

const notebook = (cells: object[], language = 'python') =>
  JSON.stringify({ cells, metadata: { kernelspec: { language } }, nbformat: 4, nbformat_minor: 5 });

const cells = [
  { cell_type: 'markdown', source: ['# Title\n', '\n', 'Some *text*.'] },
  {
    cell_type: 'code',
    source: ['%matplotlib inline\n', 'import numpy as np\n', '!pip install x\n', 'np.array?\n', 'def f(x):\n', '    return x * 2'],
    outputs: [{ output_type: 'display_data', data: { 'image/png': 'iVBORw0KGgo'.repeat(1000) } }],
    execution_count: 1,
  },
  { cell_type: 'code', source: '%%bash\necho hi', outputs: [] },
  { cell_type: 'code', source: [], outputs: [] },
];

describe('notebooks', () => {
  it('converts to a percent-format script without outputs, commenting out magics', () => {
    const script = notebookToScript(notebook(cells))!;
    expect(script).toMatchObject({ extension: '.py', fence: 'python' });
    expect(script.text).toBe(`# %% [markdown]
# # Title
#
# Some *text*.

# %%
# %matplotlib inline
import numpy as np
# !pip install x
# np.array?
def f(x):
    return x * 2

# %%
# %%bash
# echo hi

# %%
`);
  });

  it('packs notebooks as skeletonized scripts, much smaller than the JSON', async () => {
    const json = notebook(cells);
    const result = await transformFile('analysis.ipynb', json, { mode: 'skeleton' });
    expect(result.language).toEqual({ id: 'notebook', fence: 'python' });
    expect(result.parseErrors).toBe(false);
    expect(result.content).toContain('def f(x):\n    ...');
    expect(result.content).not.toContain('iVBORw0KGgo');
    expect(result.content.length).toBeLessThan(json.length / 20);
  });

  it('uses the kernel language and falls back to plain text for invalid notebooks', async () => {
    expect(notebookToScript(notebook([{ cell_type: 'code', source: 'f(x) = 1' }], 'julia'))).toMatchObject({ extension: '.jl', fence: 'julia' });
    expect(notebookToScript('{not json')).toBeUndefined();
    expect(notebookToScript('{"cells": 3}')).toBeUndefined();
    const broken = await transformFile('broken.ipynb', '{not json', { mode: 'skeleton' });
    expect(broken.content).toBe('{not json');
  });
});
