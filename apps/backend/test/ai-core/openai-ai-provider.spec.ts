import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';

import { OpenAiProvider } from '../../src/modules/ai-core/infrastructure/openai-ai-provider';
import { AiUsageTrackingService } from '../../src/modules/ai-core/infrastructure/ai-usage-tracking.service';

/**
 * B8 — THE SECONDARY RING, ON ITS OWN.
 *
 * The one thing worth stating up front, because it is the design decision this
 * file exists to protect: **this adapter speaks HTTP and imports no SDK.**
 * `ai-boundary.spec.ts` asserts that exactly one file in the whole backend
 * imports a vendor AI SDK, and adding failover did not make it two. These tests
 * exercise the HTTP contract directly by stubbing `global.fetch`.
 */

describe('OpenAiProvider — the secondary ring', () => {
  let provider: OpenAiProvider;
  const usage = { record: jest.fn() };
  const config = { get: jest.fn() };
  const originalFetch = global.fetch;

  async function build(env: Record<string, string | undefined>): Promise<OpenAiProvider> {
    config.get.mockImplementation((key: string) => env[key]);
    const moduleRef = await Test.createTestingModule({
      providers: [
        OpenAiProvider,
        { provide: ConfigService, useValue: config },
        { provide: AiUsageTrackingService, useValue: usage },
      ],
    }).compile();
    return moduleRef.get(OpenAiProvider);
  }

  const okResponse = (content: string) => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 120, completion_tokens: 40 },
    }),
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('configuration', () => {
    it('is NOT configured without a key, and says so rather than failing later', async () => {
      provider = await build({});
      expect(provider.isConfigured()).toBe(false);
      expect(provider.getProviderInfo()).toEqual({ provider: 'openai', model: 'gpt-4o-mini', configured: false });
    });

    it('refuses to call when unconfigured — the chain skips it, but a direct call is honest', async () => {
      provider = await build({});
      await expect(provider.complete({ systemPrompt: 's', userMessage: 'u' })).rejects.toThrow(
        'not configured',
      );
    });

    it('takes its model and base URL from env, never from a hardcoded constant at the call site', async () => {
      provider = await build({
        OPENAI_API_KEY: 'sk-test',
        OPENAI_MODEL: 'gpt-4.1-mini',
        OPENAI_BASE_URL: 'https://gateway.internal/v1',
      });
      global.fetch = jest.fn().mockResolvedValue(okResponse('حسنًا')) as unknown as typeof fetch;

      await provider.complete({ systemPrompt: 's', userMessage: 'u' });

      const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
      expect(url).toBe('https://gateway.internal/v1/chat/completions');
      expect(JSON.parse(init.body).model).toBe('gpt-4.1-mini');
    });
  });

  describe('the HTTP contract', () => {
    beforeEach(async () => {
      provider = await build({ OPENAI_API_KEY: 'sk-test' });
    });

    it('carries the system prompt as the FIRST MESSAGE — the one real shape difference, absorbed here', async () => {
      global.fetch = jest.fn().mockResolvedValue(okResponse('نص')) as unknown as typeof fetch;
      await provider.complete({ systemPrompt: 'SYS', userMessage: 'USER' });

      const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
      expect(body.messages).toEqual([
        { role: 'system', content: 'SYS' },
        { role: 'user', content: 'USER' },
      ]);
    });

    it('returns the completion text', async () => {
      global.fetch = jest.fn().mockResolvedValue(okResponse('نص أدفأ')) as unknown as typeof fetch;
      expect(await provider.complete({ systemPrompt: 's', userMessage: 'u' })).toBe('نص أدفأ');
    });

    it('records real token usage so per-family cost stays attributable across BOTH rings', async () => {
      global.fetch = jest.fn().mockResolvedValue(okResponse('نص')) as unknown as typeof fetch;
      await provider.complete({ systemPrompt: 's', userMessage: 'u', sourceFeature: 'ai-core.parent-coach' });
      expect(usage.record).toHaveBeenCalledWith('gpt-4o-mini', 120, 40, 'ai-core.parent-coach');
    });

    it('throws on a non-2xx so the CHAIN can move to the next ring', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503 }) as unknown as typeof fetch;
      await expect(provider.complete({ systemPrompt: 's', userMessage: 'u' })).rejects.toThrow('HTTP 503');
    });

    it('throws on an empty completion rather than returning an empty string to a caller', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: '   ' } }] }),
      }) as unknown as typeof fetch;
      await expect(provider.complete({ systemPrompt: 's', userMessage: 'u' })).rejects.toThrow('no text content');
    });

    it('passes an AbortSignal — a hung socket is exactly what a chain exists for', async () => {
      global.fetch = jest.fn().mockResolvedValue(okResponse('نص')) as unknown as typeof fetch;
      await provider.complete({ systemPrompt: 's', userMessage: 'u', timeoutMs: 5_000 });
      const init = (global.fetch as jest.Mock).mock.calls[0][1];
      expect(init.signal).toBeDefined();
    });

    it('never puts the API key anywhere but the Authorization header', async () => {
      global.fetch = jest.fn().mockResolvedValue(okResponse('نص')) as unknown as typeof fetch;
      await provider.complete({ systemPrompt: 's', userMessage: 'u' });

      const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
      expect(url).not.toContain('sk-test');
      expect(init.body).not.toContain('sk-test');
      expect(init.headers.authorization).toBe('Bearer sk-test');
      expect(JSON.stringify(provider.getProviderInfo())).not.toContain('sk-test');
    });
  });
});
