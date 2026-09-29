export type EncodingName = 'cl100k_base' | 'o200k_base';

export interface ModelPricing {
  /** Identifier used with `--models`. */
  id: string;
  /** Display name. */
  label: string;
  /** Tokenizer used to estimate this model's token count. */
  encoding: EncodingName;
  /** USD per million input tokens. */
  inputPerMTok: number;
  /**
   * Whether the token count is an estimate from a different tokenizer
   * (Claude's tokenizer is not public; cl100k_base is a close proxy).
   */
  approximate: boolean;
}

/** Input-token list prices (USD / 1M tokens) at the time of writing. */
export const MODELS: readonly ModelPricing[] = [
  { id: 'claude-3.5-sonnet', label: 'Claude 3.5 Sonnet', encoding: 'cl100k_base', inputPerMTok: 3, approximate: true },
  { id: 'claude-sonnet-5.5', label: 'Claude Sonnet 5.5', encoding: 'cl100k_base', inputPerMTok: 2, approximate: true },
  { id: 'claude-opus-5.5', label: 'Claude Opus 5.5', encoding: 'cl100k_base', inputPerMTok: 4, approximate: true },
  { id: 'claude-haiku-4.5', label: 'Claude Haiku 4.5', encoding: 'cl100k_base', inputPerMTok: 1, approximate: true },
  { id: 'claude-fable-5.1', label: 'Claude Fable 5.1', encoding: 'cl100k_base', inputPerMTok: 10, approximate: true },
  { id: 'gpt-4o', label: 'GPT-4o', encoding: 'o200k_base', inputPerMTok: 2.5, approximate: false },
  { id: 'gpt-4o-mini', label: 'GPT-4o mini', encoding: 'o200k_base', inputPerMTok: 0.15, approximate: false },
  { id: 'gpt-4-turbo', label: 'GPT-4 Turbo', encoding: 'cl100k_base', inputPerMTok: 10, approximate: false },
];

export const DEFAULT_MODELS = ['claude-3.5-sonnet', 'claude-sonnet-5.5', 'gpt-4o'] as const;

export function findModel(id: string): ModelPricing | undefined {
  const needle = id.trim().toLowerCase();
  return MODELS.find((m) => m.id === needle);
}

export function costUsd(tokens: number, model: ModelPricing): number {
  return (tokens / 1_000_000) * model.inputPerMTok;
}
