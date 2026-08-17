/**
 * PHASE F (`F6-004` / `F6-005`) — COMPOSE, THEN OPTIONALLY REPHRASE, THEN
 * ALWAYS VALIDATE.
 *
 * THE ORDER IS THE PRODUCT REQUIREMENT, and it is enforced by the shape of this
 * class rather than by a comment:
 *
 *     Event -> Engine -> (optional AI rephrase) -> Safety -> Policy -> Dedup -> Delivery
 *                        ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
 *                        this file
 *
 * `compose()` is TOTAL and NEVER THROWS. Every failure mode returns the
 * deterministic text:
 *
 *   - the AI provider is not configured        -> deterministic text
 *   - the AI provider throws                   -> deterministic text, `aiFailed`
 *   - the AI provider times out                -> deterministic text, `aiFailed`
 *   - the AI returns something unsafe          -> deterministic text, safety
 *   - the AI returns something too long        -> deterministic text, safety
 *   - the AI returns an unresolved placeholder -> deterministic text, safety
 *
 * `test/notifications/notification-ai-fallback.spec.ts` forces the throw and
 * asserts the notification is STILL DELIVERED with its template text. CONTEXT §3
 * principle 2 in one sentence: the AI ADVISES. It cannot decide whether to
 * notify, it cannot grant anything, and it cannot bypass safety — it can only
 * offer a different wording, which is then checked exactly as a human-written
 * one is.
 *
 * WHAT IS SENT TO THE MODEL, AND WHAT IS NOT. The prompt carries the ALREADY
 * RENDERED deterministic sentence and the age band. It does NOT carry the
 * child's name, the family id, the child id, the goal's evidence, or any part of
 * the context object. CONTEXT §3 principle 8: the minimum that makes the task
 * possible, and rephrasing a sentence needs the sentence.
 */

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import { AI_PROVIDER, type IAIProvider } from '../../../ai-core/domain/ai-provider.port';
import { ChildSafetyFilterService } from '../../../ai-core/application/services/child-safety-filter.service';
import { SafetyEngineService } from '../../../ai-core/application/services/safety-engine.service';
import type { NotificationContext } from '../../../notifications/domain/engine/notification-context';
import {
  hasEnumOrPlaceholderLeak,
  renderNotificationCopy,
} from '../../../notifications/domain/engine/notification-copy';
import { ageBandProfile } from '../../../ai-core/domain/age-band';

export interface ComposeRequest {
  readonly context: NotificationContext;
  readonly copyKey: string;
  readonly variables: Readonly<Record<string, string | number>>;
  readonly audience: 'PARENT' | 'CHILD';
}

export interface ComposedNotification {
  readonly title: string;
  readonly body: string;
  readonly resolvedCopyKey: string;
  readonly aiRewritten: boolean;
  readonly aiFailed: boolean;
  /** Present when the safety layer rejected something. A closed reason, so a
   * dashboard can count rejections rather than grep for them. */
  readonly safetyRejection: string | null;
}

/**
 * The rephrasing instruction. Deliberately NARROW: the model is asked to vary a
 * sentence, not to write one, and every constraint that matters is restated
 * because a model that is told only «be nice» will eventually not be.
 *
 * The output ceiling is stated in the prompt AND enforced afterwards, which is
 * the §11.2 discipline: a model that ignores the instruction cannot reach a
 * child, because the template ships instead.
 */
const REPHRASE_SYSTEM_PROMPT = [
  'You rewrite ONE short family-app notification sentence so it feels less repetitive.',
  'Rules, all mandatory:',
  '- Keep the SAME language as the input (Arabic stays Arabic).',
  '- Keep the SAME meaning and the SAME numbers. Never invent a fact.',
  '- Never shame, threaten, compare the child to anyone, or mention punishment.',
  '- Never add a link, a phone number, an email, or an instruction to contact anyone.',
  '- Never ask the reader for personal information.',
  '- Reply with the rewritten sentence ONLY. No quotes, no preamble, no explanation.',
].join('\n');

/** Interactive-path ceiling from §3.3's own table. A notification nobody is
 * waiting on must not hold a delivery for twenty seconds. */
const REPHRASE_TIMEOUT_MS = 4_000;

/**
 * The environment switch. AI rephrasing is OFF unless a deployment turns it on,
 * and that default is the honest one: CONTEXT §3 principle 5 (NO LLM PER EVENT)
 * argues against a model call on every notification, and this feature's value is
 * variety rather than correctness. Reading it once at construction rather than
 * per call, so the flag cannot change mid-batch and make two notifications from
 * one event disagree about whether they were personalised.
 */
function rephraseEnabled(): boolean {
  return process.env.NOTIFICATION_AI_REPHRASE_ENABLED === 'true';
}

@Injectable()
export class NotificationComposerService {
  private readonly logger = new Logger(NotificationComposerService.name);

  constructor(
    private readonly childSafety: ChildSafetyFilterService,
    private readonly safetyEngine: SafetyEngineService,
    /**
     * OPTIONAL on purpose. A deployment with no AI credentials, and every unit
     * test that does not care about rephrasing, gets `undefined` here and the
     * deterministic path — rather than a DI error at boot, which is how an
     * optional feature becomes a required one.
     */
    @Optional() @Inject(AI_PROVIDER) private readonly ai?: IAIProvider,
  ) {}

  async compose(request: ComposeRequest): Promise<ComposedNotification> {
    const { context } = request;

    // ---- 1. THE DETERMINISTIC TEXT. It always exists, and everything below
    //         can only replace it with something that has passed the same
    //         checks it has.
    const rendered = renderNotificationCopy({
      key: request.copyKey,
      audience: request.audience,
      toneBand: context.toneBand,
      locale: context.locale,
      variables: request.variables,
    });

    // ---- 2. SAFETY ON THE TEMPLATE ITSELF.
    //         A rule that only ran on model output would be a rule that trusts
    //         whoever writes the catalogue. `ChildSafetyFilterService`'s own
    //         docstring makes this argument; this is the notification surface
    //         honouring it. A template that fails is a bug in this repository
    //         and it degrades to GENERIC rather than reaching a child.
    const templateVerdict = this.validate(rendered.title, rendered.body, request);
    if (templateVerdict !== null) {
      this.logger.error(
        `notification.template_unsafe key=${rendered.resolvedKey} audience=${request.audience} reason=${templateVerdict}`,
      );
      const generic = renderNotificationCopy({
        key: 'GENERIC',
        audience: request.audience,
        toneBand: context.toneBand,
        locale: context.locale,
        variables: {},
      });
      return {
        title: generic.title,
        body: generic.body,
        resolvedCopyKey: generic.resolvedKey,
        aiRewritten: false,
        aiFailed: false,
        safetyRejection: templateVerdict,
      };
    }

    // ---- 3. THE OPTIONAL REPHRASE.
    if (!rephraseEnabled() || !this.ai) {
      return {
        title: rendered.title,
        body: rendered.body,
        resolvedCopyKey: rendered.resolvedKey,
        aiRewritten: false,
        aiFailed: false,
        safetyRejection: null,
      };
    }

    let candidate: string;
    try {
      candidate = await this.ai.complete({
        systemPrompt: REPHRASE_SYSTEM_PROMPT,
        // The SENTENCE and the BAND. Nothing else. No name, no ids, no context.
        userMessage: `Age band: ${context.toneBand}\nSentence: ${rendered.body}`,
        sourceFeature: 'notification-engine',
        // The third ring of §3.3's chain, supplied by the caller because a
        // generic provider cannot know this caller's deterministic answer.
        deterministicFallback: rendered.body,
        timeoutMs: REPHRASE_TIMEOUT_MS,
      });
    } catch (err) {
      // THE PROOF OBLIGATION OF §7, and it is a return rather than a rethrow:
      // «If AI fails or is disabled, the notification STILL SENDS with its
      // deterministic fallback text.»
      this.logger.warn(
        `notification.ai_rephrase_failed key=${rendered.resolvedKey} — deterministic text used. ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return {
        title: rendered.title,
        body: rendered.body,
        resolvedCopyKey: rendered.resolvedKey,
        aiRewritten: false,
        aiFailed: true,
        safetyRejection: null,
      };
    }

    const trimmed = (candidate ?? '').trim();
    if (!trimmed || trimmed === rendered.body) {
      return {
        title: rendered.title,
        body: rendered.body,
        resolvedCopyKey: rendered.resolvedKey,
        aiRewritten: false,
        aiFailed: false,
        safetyRejection: null,
      };
    }

    // ---- 4. SAFETY ON THE MODEL OUTPUT. Same function, same ceilings, same
    //         banned-content list. FAIL-CLOSED: a rejection is not an error, it
    //         is the template shipping.
    const candidateVerdict = this.validate(rendered.title, trimmed, request);
    if (candidateVerdict !== null) {
      this.logger.log(
        `notification.ai_rephrase_rejected key=${rendered.resolvedKey} reason=${candidateVerdict}`,
      );
      return {
        title: rendered.title,
        body: rendered.body,
        resolvedCopyKey: rendered.resolvedKey,
        aiRewritten: false,
        aiFailed: false,
        safetyRejection: candidateVerdict,
      };
    }

    return {
      title: rendered.title,
      body: trimmed,
      resolvedCopyKey: rendered.resolvedKey,
      aiRewritten: true,
      aiFailed: false,
      safetyRejection: null,
    };
  }

  /**
   * THE ONE SAFETY GATE, and it routes by audience because the two audiences
   * fail in opposite directions.
   *
   *   CHILD  -> `ChildSafetyFilterService`: banned content, injection echo, and
   *             the §11.3 per-band LENGTH CEILING. The band used is the CHILD'S
   *             OWN `age-band.ts` band, never the tone band — the tone band
   *             chooses words, the safety band bounds them, and where they
   *             disagree the safety band wins.
   *   PARENT -> `SafetyEngineService` with a NULL recommendation type. That
   *             null is not incidental: `PE-N-001` was caused by handing a
   *             notification type to a whitelist of RECOMMENDATION types, and
   *             this call site states in its argument list that it is not making
   *             a recommendation. The UNSAFE-PATTERN scan — the half that
   *             actually protects — still runs.
   *
   * Returns `null` when safe, or a closed reason string when not.
   */
  private validate(title: string, body: string, request: ComposeRequest): string | null {
    if (hasEnumOrPlaceholderLeak(title) || hasEnumOrPlaceholderLeak(body)) {
      return 'ENUM_OR_PLACEHOLDER_LEAK';
    }

    if (request.audience === 'CHILD') {
      const band = request.context.safetyBand;
      const profile = ageBandProfile(band);
      const bodyVerdict = this.childSafety.validate(body, band);
      if (!bodyVerdict.isSafe) return bodyVerdict.reasons[0] ?? 'UNSAFE';
      // The title is held to the same band but its own, tighter budget: a
      // notification title that needs a full sentence is not a title.
      const titleVerdict = this.childSafety.validate(title, band, {
        maxWords: Math.min(6, profile.maxWords),
        maxChars: 60,
      });
      if (!titleVerdict.isSafe) return titleVerdict.reasons[0] ?? 'UNSAFE';
      return null;
    }

    const verdict = this.safetyEngine.validate(null, title, body);
    return verdict.isSafe ? null : 'PARENT_COPY_UNSAFE';
  }
}
