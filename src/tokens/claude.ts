import type { ModelPricing } from './pricing.js';

export class ClaudeCountError extends Error {}

/**
 * Exact input-token counts from Anthropic's token-counting endpoint
 * (`messages.countTokens`), one request per model since tokenizers differ between model
 * generations. Uses the official SDK, an optional dependency loaded on demand, which
 * resolves credentials from ANTHROPIC_API_KEY and friends. Models the API cannot count
 * (e.g. retired ones) are left out of the result.
 */
export async function countClaudeTokens(text: string, models: readonly ModelPricing[]): Promise<Map<string, number>> {
  const targets = models.filter((m) => m.anthropicModel);
  const counts = new Map<string, number>();
  if (!targets.length) return counts;

  let sdk: typeof import('@anthropic-ai/sdk');
  try {
    sdk = await import('@anthropic-ai/sdk');
  } catch {
    throw new ClaudeCountError('--claude-tokens needs the optional dependency @anthropic-ai/sdk (npm install @anthropic-ai/sdk)');
  }
  const Anthropic = sdk.default;
  let client: InstanceType<typeof Anthropic>;
  try {
    client = new Anthropic();
  } catch (error) {
    throw new ClaudeCountError(`--claude-tokens needs Anthropic credentials (set ANTHROPIC_API_KEY): ${(error as Error).message}`);
  }

  for (const model of targets) {
    try {
      const response = await client.messages.countTokens({
        model: model.anthropicModel!,
        messages: [{ role: 'user', content: text }],
      });
      counts.set(model.id, response.input_tokens);
    } catch (error) {
      if (error instanceof Anthropic.NotFoundError) continue; // model not available to count
      if (error instanceof Anthropic.AuthenticationError) {
        throw new ClaudeCountError('Anthropic rejected the API key used for --claude-tokens');
      }
      if (error instanceof Anthropic.APIError) {
        throw new ClaudeCountError(`Token counting failed for ${model.label} (${error.status ?? 'network'}): ${error.message}`);
      }
      throw error;
    }
  }
  return counts;
}
