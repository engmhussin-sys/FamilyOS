import { Test } from '@nestjs/testing';

import {
  AI_PROVIDER_PRIMARY,
  AI_PROVIDER_SECONDARY,
  AiChainExhaustedError,
  type IAIProviderAdapter,
} from '../../src/modules/ai-core/domain/ai-provider.port';
import { FallbackAiProvider } from '../../src/modules/ai-core/infrastructure/fallback-ai-provider';
import { AiBudgetService } from '../../src/modules/ai-core/infrastructure/ai-budget.service';

/**
 * B8 — THE FALLBACK CHAIN (PA-B-027 closed).
 *
 * Phase A's finding, in its own words: «لا provider احتياطي رغم أن CONTEXT §2
 * يفرضه … مزوّد واحد ثابت … انقطاع Anthropic = تعطّل /ai-assistant/ask بالكامل».
 * This file is the proof that a second ring now exists, that it takes over, and
 * that the takeover is invisible to every caller.
 */

class FakeAdapter implements IAIProviderAdapter {
  calls = 0;
  constructor(
    readonly id: string,
    private behaviour: 'ok' | 'throw' | 'unconfigured',
    private answer = `answer-from-${id}`,
  ) {}

  isConfigured(): boolean {
    return this.behaviour !== 'unconfigured';
  }

  async complete(): Promise<string> {
    this.calls++;
    if (this.behaviour === 'throw') throw new Error(`${this.id} is down`);
    return this.answer;
  }

  setBehaviour(b: 'ok' | 'throw' | 'unconfigured'): void {
    this.behaviour = b;
  }
}

describe('FallbackAiProvider — primary → secondary → deterministic template (§3.3)', () => {
  let primary: FakeAdapter;
  let secondary: FakeAdapter;
  let budget: { hasBudget: jest.Mock };
  let chain: FallbackAiProvider;

  async function build(p: FakeAdapter, s: FakeAdapter): Promise<FallbackAiProvider> {
    const moduleRef = await Test.createTestingModule({
      providers: [
        FallbackAiProvider,
        { provide: AI_PROVIDER_PRIMARY, useValue: p },
        { provide: AI_PROVIDER_SECONDARY, useValue: s },
        { provide: AiBudgetService, useValue: budget },
      ],
    }).compile();
    return moduleRef.get(FallbackAiProvider);
  }

  beforeEach(async () => {
    budget = { hasBudget: jest.fn().mockResolvedValue(true) };
    primary = new FakeAdapter('anthropic', 'ok');
    secondary = new FakeAdapter('openai', 'ok');
    chain = await build(primary, secondary);
  });

  const req = (extra: Record<string, unknown> = {}) => ({
    systemPrompt: 'sys',
    userMessage: 'user',
    sourceFeature: 'test',
    ...extra,
  });

  describe('the happy path is unchanged for a single-provider deployment', () => {
    it('serves from the primary and never touches the secondary', async () => {
      expect(await chain.complete(req())).toBe('answer-from-anthropic');
      expect(primary.calls).toBe(1);
      expect(secondary.calls).toBe(0);
    });

    it('an UNCONFIGURED secondary is skipped, not failed — its breaker stays CLOSED', async () => {
      secondary.setBehaviour('unconfigured');
      expect(await chain.complete(req())).toBe('answer-from-anthropic');
      expect(secondary.calls).toBe(0);
      expect(chain.getChainState()).toEqual([
        { id: 'anthropic', configured: true, circuitState: 'CLOSED' },
        { id: 'openai', configured: false, circuitState: 'CLOSED' },
      ]);
    });
  });

  describe('THE DEFECT PHASE A FOUND, FIXED', () => {
    it('when the primary is down the SECONDARY answers — the call succeeds', async () => {
      primary.setBehaviour('throw');
      expect(await chain.complete(req())).toBe('answer-from-openai');
      expect(primary.calls).toBe(1);
      expect(secondary.calls).toBe(1);
    });

    it('the caller cannot tell which ring answered — the port returns a string either way', async () => {
      const fromPrimary = await chain.complete(req());
      primary.setBehaviour('throw');
      const fromSecondary = await chain.complete(req());
      expect(typeof fromPrimary).toBe('string');
      expect(typeof fromSecondary).toBe('string');
    });
  });

  describe('the terminal ring — degraded mode is a value, not an exception (§9.3)', () => {
    it('both rings down + a deterministic fallback ⇒ the fallback is RETURNED, not thrown', async () => {
      primary.setBehaviour('throw');
      secondary.setBehaviour('throw');
      const answer = await chain.complete(req({ deterministicFallback: 'النص الحتمي' }));
      expect(answer).toBe('النص الحتمي');
    });

    it('both rings down + NO deterministic fallback ⇒ throws, because a 503 beats a wrong answer', async () => {
      primary.setBehaviour('throw');
      secondary.setBehaviour('throw');
      // This is `/ai-assistant/ask`'s case: an open-ended parenting question
      // has no template, and answering it with one would be worse than an error.
      await expect(chain.complete(req())).rejects.toBeInstanceOf(AiChainExhaustedError);
    });

    it('NOTHING configured at all ⇒ the fallback still ships, with no network attempt', async () => {
      primary.setBehaviour('unconfigured');
      secondary.setBehaviour('unconfigured');
      expect(await chain.complete(req({ deterministicFallback: 'حتمي' }))).toBe('حتمي');
      expect(primary.calls).toBe(0);
      expect(secondary.calls).toBe(0);
    });

    it('the exception names every ring it tried — a diagnosable failure, not a bare throw', async () => {
      primary.setBehaviour('throw');
      secondary.setBehaviour('throw');
      await chain.complete(req()).catch((err: AiChainExhaustedError) => {
        expect(err.attempted).toEqual(['anthropic', 'openai']);
        expect(err.lastError).toBeInstanceOf(Error);
      });
      expect.assertions(2);
    });
  });

  describe('the circuit breaker — failover is fast, not merely eventual', () => {
    it('after 5 consecutive primary failures the breaker OPENS and the primary is no longer called', async () => {
      primary.setBehaviour('throw');
      for (let i = 0; i < 5; i++) await chain.complete(req());
      expect(primary.calls).toBe(5);
      expect(chain.getChainState()[0].circuitState).toBe('OPEN');

      // The sixth call skips the dead ring entirely: this is the difference
      // between a 200 ms failover and one that pays a 20 s timeout first.
      await chain.complete(req());
      expect(primary.calls).toBe(5);
      expect(secondary.calls).toBe(6);
    });

    it('a success resets the breaker — a transient blip is not a permanent outage', async () => {
      primary.setBehaviour('throw');
      for (let i = 0; i < 3; i++) await chain.complete(req());
      primary.setBehaviour('ok');
      await chain.complete(req());
      expect(chain.getChainState()[0].circuitState).toBe('CLOSED');
    });
  });

  describe('the budget gate (§9.3) — cost control that actually stops spending', () => {
    it('over budget + a deterministic fallback ⇒ ZERO provider calls, and no error', async () => {
      budget.hasBudget.mockResolvedValue(false);
      const answer = await chain.complete(req({ deterministicFallback: 'بطاقة حتمية كاملة' }));

      expect(answer).toBe('بطاقة حتمية كاملة');
      // THE ASSERTION THAT MAKES IT A BUDGET AND NOT A REPORT: the network was
      // never touched.
      expect(primary.calls).toBe(0);
      expect(secondary.calls).toBe(0);
    });

    it('over budget WITHOUT a fallback still calls — the cap bounds bulk spend, not a parent question', async () => {
      budget.hasBudget.mockResolvedValue(false);
      expect(await chain.complete(req())).toBe('answer-from-anthropic');
      expect(primary.calls).toBe(1);
    });

    it('the budget is asked ONCE per call, not once per ring', async () => {
      primary.setBehaviour('throw');
      await chain.complete(req({ deterministicFallback: 'x' }));
      expect(budget.hasBudget).toHaveBeenCalledTimes(1);
    });
  });

  describe('what it deliberately does NOT do', () => {
    it('does not retry within a ring — each adapter owns its own retry policy', async () => {
      primary.setBehaviour('throw');
      await chain.complete(req({ deterministicFallback: 'x' }));
      // One attempt per ring. Three SDK retries times three chain retries would
      // be nine 20-second calls behind one button tap.
      expect(primary.calls).toBe(1);
      expect(secondary.calls).toBe(1);
    });
  });
});
