import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/** Config file names, in lookup order. */
export const CONFIG_FILES = ['astpack.config.json', '.astpackrc.json', '.astpackrc'] as const;

/** Options that can be set in a config file (the CLI's long option names in camelCase). */
export interface AstpackConfig {
  output?: string;
  stdout?: boolean;
  format?: 'markdown' | 'json' | 'xml';
  mode?: 'skeleton' | 'full' | 'outline';
  focus?: string[];
  clipboard?: boolean;
  ignore?: string[];
  include?: string[];
  gitignore?: boolean;
  packignore?: boolean;
  defaultIgnores?: boolean;
  maxFileSize?: number | string;
  fallbackLines?: number;
  fallbackChars?: number;
  placeholder?: string;
  comments?: 'all' | 'docs' | 'none';
  maxTokens?: number | string;
  splitTokens?: number | string;
  tree?: boolean;
  deps?: boolean;
  instructions?: string;
  followSymlinks?: boolean;
  redact?: boolean;
  changed?: string | boolean;
  diff?: string | boolean;
  models?: string[];
  top?: number;
  preset?: string;
}

type Kind = 'string' | 'boolean' | 'number' | 'string[]' | 'number|string' | 'string|boolean' | readonly string[];

export const CONFIG_SCHEMA: Record<keyof AstpackConfig, { kind: Kind; description: string }> = {
  output: { kind: 'string', description: 'Output file (relative to the config file).' },
  stdout: { kind: 'boolean', description: 'Write the document to stdout instead of a file.' },
  format: { kind: ['markdown', 'json', 'xml'], description: 'Output format.' },
  mode: { kind: ['skeleton', 'full', 'outline'], description: 'Strip function bodies (skeleton), include raw source (full) or list declarations only (outline).' },
  focus: { kind: 'string[]', description: 'Files, directories or globs kept as full source.' },
  clipboard: { kind: 'boolean', description: 'Copy the document to the clipboard.' },
  ignore: { kind: 'string[]', description: 'Extra gitignore-style exclude patterns (merged with --ignore).' },
  include: { kind: 'string[]', description: 'Only include files matching these patterns (merged with --include).' },
  gitignore: { kind: 'boolean', description: 'Honour .gitignore files.' },
  packignore: { kind: 'boolean', description: 'Honour .packignore / .astpackignore files.' },
  defaultIgnores: { kind: 'boolean', description: 'Apply the built-in excludes.' },
  maxFileSize: { kind: 'number|string', description: 'Skip files larger than this (bytes or e.g. "1mb").' },
  fallbackLines: { kind: 'number', description: 'Max lines kept from unsupported files in skeleton mode.' },
  fallbackChars: { kind: 'number', description: 'Max characters kept from unsupported files in skeleton mode.' },
  placeholder: { kind: 'string', description: 'Marker text for stripped bodies.' },
  comments: { kind: ['all', 'docs', 'none'], description: 'Comments to keep outside focused files.' },
  maxTokens: { kind: 'number|string', description: 'Token budget for the document (e.g. 100000 or "100k").' },
  splitTokens: { kind: 'number|string', description: 'Split the output into parts of at most this many tokens.' },
  tree: { kind: 'boolean', description: 'Include the directory tree.' },
  deps: { kind: 'boolean', description: 'Include the internal import graph.' },
  instructions: { kind: 'string', description: 'Instructions placed at the top (prefix with @ to read a file).' },
  followSymlinks: { kind: 'boolean', description: 'Follow symbolic links.' },
  redact: { kind: 'boolean', description: 'Mask likely secrets.' },
  changed: { kind: 'string|boolean', description: 'Focus files changed vs a git ref (true = HEAD).' },
  diff: { kind: 'string|boolean', description: 'Include the git diff vs a ref (true = the --changed ref or HEAD).' },
  models: { kind: 'string[]', description: 'Models to price in the summary.' },
  top: { kind: 'number', description: 'Number of largest files listed in the summary.' },
  preset: { kind: ['review', 'explain', 'refactor', 'debug'], description: 'Ready-made options and instructions for a task.' },
};

export class ConfigError extends Error {}

function checkKind(key: string, value: unknown, kind: Kind): void {
  const fail = (expected: string) => {
    throw new ConfigError(`"${key}" must be ${expected}, got ${JSON.stringify(value)}`);
  };
  if (Array.isArray(kind)) {
    if (typeof value !== 'string' || !kind.includes(value)) fail(`one of ${kind.join(', ')}`);
    return;
  }
  switch (kind) {
    case 'string':
      if (typeof value !== 'string') fail('a string');
      break;
    case 'boolean':
      if (typeof value !== 'boolean') fail('a boolean');
      break;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail('a non-negative number');
      break;
    case 'string[]':
      if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) fail('an array of strings');
      break;
    case 'number|string':
      if (typeof value !== 'number' && typeof value !== 'string') fail('a number or string');
      break;
    case 'string|boolean':
      if (typeof value !== 'string' && typeof value !== 'boolean') fail('a string or boolean');
      break;
  }
}

/** Validate a parsed config object. Returns the config and warnings for unknown keys. */
export function validateConfig(raw: unknown): { config: AstpackConfig; warnings: string[] } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new ConfigError('config must be a JSON object');
  const warnings: string[] = [];
  const config: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === '$schema') continue;
    const entry = CONFIG_SCHEMA[key as keyof AstpackConfig];
    if (!entry) {
      warnings.push(`unknown config key "${key}"`);
      continue;
    }
    checkKind(key, value, entry.kind);
    config[key] = value;
  }
  return { config: config as AstpackConfig, warnings };
}

export interface LoadedConfig {
  path: string;
  /** Directory containing the config file. */
  dir: string;
  config: AstpackConfig;
  warnings: string[];
}

/** Find a config file in `dirs` (first match wins). */
export function findConfig(dirs: readonly string[]): string | undefined {
  for (const dir of dirs) {
    for (const name of CONFIG_FILES) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/** Load, validate and path-normalize a config file. */
export async function loadConfig(path: string): Promise<LoadedConfig> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new ConfigError(`cannot read ${path}: ${(error as Error).message}`);
  }
  let validated;
  try {
    validated = validateConfig(raw);
  } catch (error) {
    throw new ConfigError(`${path}: ${(error as Error).message}`);
  }
  const { config, warnings } = validated;
  const base = dirname(path);
  const abs = (p: string) => (isAbsolute(p) ? p : resolve(base, p));
  // Paths in a config file are relative to the file, not to wherever astpack runs.
  if (config.output) config.output = abs(config.output);
  // `focus` stays relative: it names files in the project being packed, which is resolved
  // later (it differs from the config's directory with --remote).
  if (config.instructions?.startsWith('@')) config.instructions = `@${abs(config.instructions.slice(1))}`;
  return { path, dir: base, config, warnings: warnings.map((w) => `${path}: ${w}`) };
}

/** Default config written by `astpack init`. */
export function defaultConfig(): Record<string, unknown> {
  return {
    $schema: 'https://unpkg.com/astpack/schema.json',
    format: 'markdown',
    mode: 'skeleton',
    comments: 'all',
    focus: [],
    ignore: [],
    output: 'astpack-output.md',
    models: ['claude-sonnet-5.5', 'gpt-4o'],
  };
}

/** JSON Schema for the config file (published as schema.json). */
export function configJsonSchema(): Record<string, unknown> {
  const properties: Record<string, unknown> = { $schema: { type: 'string' } };
  for (const [key, { kind, description }] of Object.entries(CONFIG_SCHEMA)) {
    let type: unknown;
    if (Array.isArray(kind)) type = { type: 'string', enum: kind };
    else if (kind === 'string[]') type = { type: 'array', items: { type: 'string' } };
    else if (kind === 'number|string') type = { type: ['number', 'string'] };
    else if (kind === 'string|boolean') type = { type: ['string', 'boolean'] };
    else if (kind === 'number') type = { type: 'number', minimum: 0 };
    else type = { type: kind };
    properties[key] = { ...(type as object), description };
  }
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'astpack configuration',
    type: 'object',
    additionalProperties: false,
    properties,
  };
}
