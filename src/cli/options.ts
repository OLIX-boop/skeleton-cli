import type { CommentMode } from '../languages/types.js';
import type { OutputFormat } from '../output/index.js';

/** Parsed options of the main `astpack` command. */
export interface PackCliOptions {
  output?: string;
  stdout?: boolean;
  format: OutputFormat;
  skeleton?: boolean;
  full?: boolean;
  outline?: boolean;
  focus: string[];
  clipboard?: boolean;
  ignore: string[];
  include: string[];
  gitignore: boolean;
  packignore: boolean;
  defaultIgnores: boolean;
  maxFileSize?: number;
  fallbackLines?: number;
  fallbackChars?: number;
  placeholder?: string;
  comments: CommentMode;
  maxTokens?: number;
  splitTokens?: number;
  tree: boolean;
  deps?: boolean;
  instructions?: string;
  followSymlinks?: boolean;
  redact: boolean;
  changed?: string | boolean;
  diff?: string | boolean;
  remote?: string;
  config?: string | false;
  preset?: string;
  models: string[];
  claudeTokens?: boolean;
  top: number;
  quiet?: boolean;
  dryRun?: boolean;
  watch?: boolean;
  statsJson?: string;
  color: boolean;
}
