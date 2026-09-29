import { describe, expect, it, vi } from 'vitest';

const calls: { model: string; content: unknown }[] = [];
let mode: 'ok' | 'auth' = 'ok';

vi.mock('@anthropic-ai/sdk', () => {
  class APIError extends Error {
    status?: number;
  }
  class NotFoundError extends APIError {}
  class AuthenticationError extends APIError {}
  class Anthropic {
    static APIError = APIError;
    static NotFoundError = NotFoundError;
    static AuthenticationError = AuthenticationError;
    messages = {
      countTokens: async ({ model, messages }: { model: string; messages: { content: unknown }[] }) => {
        calls.push({ model, content: messages[0]!.content });
        if (mode === 'auth') throw new AuthenticationError('invalid x-api-key');
        if (model === 'claude-haiku-4-5') throw new NotFoundError('model not found');
        return { input_tokens: model === 'claude-opus-5-5' ? 130 : 120 };
      },
    };
  }
  return { default: Anthropic };
});

const { countClaudeTokens, MODELS, computeStats } = await import('../src/tokens/index.js');

const model = (id: string) => MODELS.find((m) => m.id === id)!;

describe('countClaudeTokens', () => {
  it('counts each countable Claude model and skips the rest', async () => {
    calls.length = 0;
    mode = 'ok';
    const counts = await countClaudeTokens('hello', [model('claude-sonnet-5.5'), model('claude-opus-5.5'), model('claude-haiku-4.5'), model('claude-3.5-sonnet'), model('gpt-4o')]);
    expect(Object.fromEntries(counts)).toEqual({ 'claude-sonnet-5.5': 120, 'claude-opus-5.5': 130 });
    expect(calls.map((c) => c.model)).toEqual(['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-4-5']);
    expect(calls[0]!.content).toBe('hello');
  });

  it('reports authentication failures clearly', async () => {
    mode = 'auth';
    await expect(countClaudeTokens('x', [model('claude-sonnet-5.5')])).rejects.toThrow(/rejected the API key/);
  });

  it('feeds exact counts into the cost table', () => {
    const result = {
      root: '/x',
      mode: 'skeleton' as const,
      focusOutsideRoot: [],
      skipped: [],
      files: [],
    };
    const stats = computeStats(result, 'some output text', {
      models: ['claude-sonnet-5.5', 'gpt-4o'],
      exactTokens: new Map([['claude-sonnet-5.5', 1_000_000]]),
    });
    const sonnet = stats.costs.find((c) => c.model.id === 'claude-sonnet-5.5')!;
    expect(sonnet).toMatchObject({ tokens: 1_000_000, usd: 2 });
    expect(sonnet.model.approximate).toBe(false);
    expect(stats.costs.find((c) => c.model.id === 'gpt-4o')!.model.approximate).toBe(false);
  });
});
