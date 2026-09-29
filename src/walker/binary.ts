import { open } from 'node:fs/promises';

const SAMPLE_SIZE = 8192;

/** Heuristic used by git and most editors: a NUL byte in the first 8 KiB means binary. */
export function looksBinary(sample: Uint8Array): boolean {
  return sample.includes(0);
}

export async function isBinaryFile(absPath: string): Promise<boolean> {
  const handle = await open(absPath, 'r');
  try {
    const buffer = new Uint8Array(SAMPLE_SIZE);
    const { bytesRead } = await handle.read(buffer, 0, SAMPLE_SIZE, 0);
    return looksBinary(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}
