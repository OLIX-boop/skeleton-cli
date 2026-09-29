import { renderJson } from './json.js';
import { renderMarkdown } from './markdown.js';
import type { OutputFormat, Renderer } from './types.js';
import { renderXml } from './xml.js';

export { renderTree } from './tree.js';
export { toJsonDocument, type JsonDocument } from './json.js';
export { OUTPUT_EXTENSIONS, OUTPUT_FORMATS, type OutputFormat, type RenderOptions } from './types.js';

export const RENDERERS: Record<OutputFormat, Renderer> = {
  markdown: renderMarkdown,
  json: renderJson,
  xml: renderXml,
};

export function render(format: OutputFormat, ...args: Parameters<Renderer>): string {
  return RENDERERS[format](...args);
}
