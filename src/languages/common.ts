/** `{ /* text *\/ }` — a valid empty block in every C-family language. */
export function braceBlock(placeholder: string): string {
  return `{ /* ${placeholder} */ }`;
}
