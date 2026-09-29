import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** Create a temporary directory tree from a `{ 'path/to/file': contents }` map. */
export async function makeTree(files: Record<string, string | Uint8Array>): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'astpack-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    await mkdir(dirname(abs), { recursive: true });
    if (rel.endsWith('/')) continue;
    await writeFile(abs, content);
  }
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

export async function makeSymlink(root: string, target: string, link: string): Promise<void> {
  await symlink(join(root, target), join(root, link));
}
