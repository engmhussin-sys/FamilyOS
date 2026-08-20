import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';

import { AI_PROVIDER, type IAIProvider } from '../../domain/ai-provider.port';
import { ageBandProfile } from '../../domain/age-band';
import type { AgeBand } from '../../domain/age-band';
import {
  childTopicAnswer,
  encouragementTemplate,
  listChildTopics,
  type ChildTopic,
  type ChildTopicCode,
  type EncouragementIntent,
} from '../../domain/child-coach-content';
import { COACH_SIGNAL_PROVIDER, type ICoachSignalProvider } from '../../domain/coach.types';
import type { CoachSignals } from '../../domain/coach.types';
import { UNTRUSTED_CONTENT_RULE } from '../../domain/prompt-safety';
import { ChildSafetyFilterService } from './child-safety-filter.service';

/** §3.3: a child encouragement line is short, cheap, and never worth making a
 * child wait for. Eight seconds, then the template ships. */
const CHILD_TIMEOUT_MS = 8_000;

/**
 * §6.2's `child_encouragement/v2.0.0`, transcribed. Note what is NOT in it:
 * any instruction about what to SAY. The model is handed one approved sentence
 * and asked to vary its wording inside a word ceiling. It is never told the
 * child's numbers beyond the single integer already inside the template, never
 * told the parent's anything, and never asked a question.
 */
const CHILD_PHRASING_PROMPT = [
  'أنت تعيد صياغة جملة تشجيع واحدة موجّهة لطفل، بالعربية.',
  '١. جملة واحدة فقط، بمفردات مناسبة للفئة العمرية المذكورة.',
  '٢. ممنوع منعًا باتًا: التهديد، التذكير بالعقاب، إثارة الشعور بالذنب، المقارنة بأخ أو صديق،',
  '   ذكر أي رقم لم يُعطَ لك، ذكر أي بيانات تخص الوالد، أي سؤال يطلب معلومة من الطفل.',
  '٣. ممنوع طلب أي فعل خارج التطبيق: لا روابط، لا تواصل، لا "أخبر والدك بـ...".',
  '٤. النبرة: دافئة، مباشرة، بلا مبالغة وبلا وعظ.',
  `٥. ${UNTRUSTED_CONTENT_RULE}`,
  '٦. أجب بالجملة فقط.',
].join('\n');

export interface ChildEncouragement {
  readonly intent: EncouragementIntent;
  readonly ageBand: AgeBand;
  readonly messageAr: string;
  /** True when a provider's variation passed the safety filter and shipped.
   * False means the human-written template shipped — which is the normal case
   * and never an error. */
  readonly phrasedByAi: boolean;
  readonly businessDate: string;
}

export interface ChildAnswer {
  readonly code: ChildTopicCode;
  readonly ageBand: AgeBand;
  readonly answerAr: string;
  /** Always false. The closed-vocabulary path never calls a provider, and this
   * field exists so a client (and a test) can assert that rather than trust it. */
  readonly phrasedByAi: false;
}

/**
 * B8 — THE CHILD AI SURFACE.
 *
 * THE DECISION THAT DID NOT CHANGE: **no open-ended chat with a child**
 * (§11.1). The four reasons in that section still hold, and B8 did not
 * relitigate them. What B8 added is bounded, and here is the exact boundary,
 * stated so the review does not have to infer it:
 *
 *   EXTENDED  → `GET /self/coach/today` (an encouragement card) and
 *               `GET /self/coach/answer/:code` (an answer from a closed list).
 *   GATED BY  → for `today`: no child input exists at all; the intent is chosen
 *               by rules from server-side numbers, and the text is a
 *               human-written template that a provider may only re-word.
 *               For `answer`: the input is a member of `CHILD_TOPIC_CODES` —
 *               a nine-value enum validated in the controller — and NO provider
 *               is called on that path at any point.
 *   NOT ADDED → any endpoint where a child's free text produces model output.
 *               `POST /self/coach/checkin` accepts free text and is handled by
 *               `DistressEscalationService`, which classifies it OFFLINE and
 *               returns either a fixed human-written card or a template. There
 *               is no code path from a child's keyboard to
 *               `IAIProvider.complete`, and `child-ai-boundary.spec.ts` fails
 *               if one is added.
 *
 * FAIL-CLOSED, ALWAYS (§11.2). Every candidate string — model output OR
 * template — passes `ChildSafetyFilterService` before it leaves this class. If
 * the model's variation fails, the template ships. If the TEMPLATE somehow
 * fails, a hard-coded minimal line ships. The child never sees an error, a
 * blank card, or a retry prompt, because a child interpreting an outage as
 * their own fault is a real product failure and a cheap one to prevent.
 */
@Injectable()
export class ChildCoachService {
  private readonly logger = new Logger(ChildCoachService.name);

  constructor(
    @Inject(COACH_SIGNAL_PROVIDER) private readonly signals: ICoachSignalProvider,
    @Inject(AI_PROVIDER) private readonly ai: IAIProvider,
    private readonly safety: ChildSafetyFilterService,
  ) {}

  async today(childId: string, familyId: string, now: Date = new Date()): Promise<ChildEncouragement> {
    const signals = await this.signals.build(childId, familyId, now);
    const intent = this.selectIntent(signals);
    const band = signals.ageBand;
    const n = intent === 'CELEBRATE' ? signals.streak.currentDays : signals.habits.completed7d;

    // Deterministic pick: same child, same business date, same line. Not
    // `Math.random()` — a card that changes on refresh is a card a child
    // refreshes, and an endpoint whose output cannot be reproduced is an
    // endpoint whose safety cannot be reviewed.
    const pick = this.stableIndex(`${childId}|${signals.businessDate}|${intent}`);
    const template = encouragementTemplate(intent, band, pick, n);

    const message = await this.varyWithinSafety(template, band);
    return {
      intent,
      ageBand: band,
      messageAr: message.text,
      phrasedByAi: message.usedCandidate,
      businessDate: signals.businessDate,
    };
  }

  /** The closed vocabulary the child app renders as buttons. */
  topics(): readonly ChildTopic[] {
    return listChildTopics();
  }

  /**
   * NO PROVIDER CALL ON THIS PATH, BY CONSTRUCTION. The answer is looked up
   * from a human-written table by (code, band). `this.ai` is not referenced in
   * this method, and the test asserts the provider's call count is zero across
   * every code × every band.
   */
  async answer(
    childId: string,
    familyId: string,
    code: ChildTopicCode,
    now: Date = new Date(),
  ): Promise<ChildAnswer> {
    const signals = await this.signals.build(childId, familyId, now);
    const band = signals.ageBand;
    const text = childTopicAnswer(code, band);

    // The library is validated at rest by its own spec; this is the runtime
    // net, because a table edited in a hurry is exactly how an over-long line
    // reaches a six-year-old.
    const verdict = this.safety.validate(text, band, answerLimits(band));
    if (!verdict.isSafe) {
      this.logger.error(
        JSON.stringify({ event: 'child_topic_answer_unsafe', code, band, reasons: verdict.reasons }),
      );
      return { code, ageBand: band, answerAr: MINIMAL_SAFE_LINE, phrasedByAi: false };
    }

    return { code, ageBand: band, answerAr: text, phrasedByAi: false };
  }

  /**
   * THE INTENT SELECTOR (§11.2), deterministic. Four branches, evaluated in
   * severity order, over numbers the server computed. No model participates in
   * choosing what kind of thing to say to a child — only in how to say the
   * sentence that was already chosen.
   */
  private selectIntent(s: CoachSignals): EncouragementIntent {
    if (s.streak.atRisk) return 'NUDGE';
    if (s.streak.currentDays === 0 && s.habits.completed28d > 0) return 'RESTART';
    if (s.habits.dueToday > 0 && s.habits.completedToday >= s.habits.dueToday) return 'REST';
    if (s.habits.completedToday > 0) return 'CELEBRATE';
    return 'NUDGE';
  }

  private stableIndex(seed: string): number {
    return parseInt(createHash('sha256').update(seed).digest('hex').slice(0, 8), 16);
  }

  /**
   * Optional variation, hard-gated. The provider is handed the TEMPLATE, not
   * the child's data: it never learns the streak length beyond the integer
   * already inside the sentence, never learns a habit title, and never learns
   * anything about the parent. Whatever comes back must clear the same filter
   * the template did, at the same age band, or it is discarded silently.
   */
  private async varyWithinSafety(template: string, band: AgeBand): Promise<{ text: string; usedCandidate: boolean }> {
    const profile = ageBandProfile(band);
    let candidate = '';
    try {
      candidate = (
        await this.ai.complete({
          systemPrompt: CHILD_PHRASING_PROMPT,
          userMessage: `الفئة العمرية: ${profile.labelAr}. الحد الأقصى ${profile.maxWords} كلمة.\nالجملة: ${template}`,
          sourceFeature: 'ai-core.child-coach',
          timeoutMs: CHILD_TIMEOUT_MS,
          deterministicFallback: template,
        })
      ).trim();
    } catch (err) {
      this.logger.debug(`child_coach.phrasing_skipped: ${err instanceof Error ? err.message : String(err)}`);
      return this.guaranteed(template, band);
    }

    if (!candidate || candidate === template) return this.guaranteed(template, band);
    const chosen = this.safety.chooseSafe(candidate, template, band);
    return chosen.usedCandidate ? chosen : this.guaranteed(template, band);
  }

  /**
   * The last line of defence: if even the human-written template fails its own
   * band's filter — a library edit that slipped through review — a five-word
   * sentence that cannot fail ships instead. A child seeing nothing is worse
   * than a child seeing something plain.
   */
  private guaranteed(template: string, band: AgeBand): { text: string; usedCandidate: boolean } {
    const verdict = this.safety.validate(template, band);
    if (verdict.isSafe) return { text: template, usedCandidate: false };
    this.logger.error(
      JSON.stringify({ event: 'child_template_unsafe', band, reasons: verdict.reasons }),
    );
    return { text: MINIMAL_SAFE_LINE, usedCandidate: false };
  }
}

/** Five words, no numbers, no comparison, no request. Safe in every band. */
const MINIMAL_SAFE_LINE = 'يومك يبدأ الآن. خطوة واحدة تكفي.';

/**
 * A topic ANSWER is an explanation, not a push-style encouragement line, so it
 * gets its own ceilings rather than borrowing the ones sized for a notification.
 * THE BAND STILL DECIDES: the word ceiling is three times the band's own, so a
 * six-year-old's longest possible answer (24 words) is still less than half a
 * seventeen-year-old's (54). Relaxed, never removed.
 */
function answerLimits(band: AgeBand): { maxChars: number; maxWords: number } {
  const profile = ageBandProfile(band);
  return { maxChars: 260, maxWords: profile.maxWords * 3 };
}
