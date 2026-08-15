import { Injectable, Logger } from '@nestjs/common';

import { ageBandProfile, countWords, type AgeBand } from '../../domain/age-band';
import { UNTRUSTED_CLOSE, UNTRUSTED_OPEN, detectInjection } from '../../domain/prompt-safety';

/**
 * A surface-specific relaxation of the BAND's ceilings, never a removal of
 * them. An encouragement line and a topic answer are different shapes of text
 * and a single number cannot be right for both; what stays fixed is that BOTH
 * are bounded, and that the bound is still derived per band by the caller.
 */
export interface ChildSafetyLimits {
  readonly maxChars?: number;
  readonly maxWords?: number;
}

export interface ChildSafetyResult {
  readonly isSafe: boolean;
  /** A closed enum, never free text — §6.2's `copy_safety_check` reason set,
   * so a rejection can be counted on a dashboard rather than grepped. */
  readonly reasons: readonly ChildSafetyReason[];
}

export const CHILD_SAFETY_REASONS = [
  'SHAMING',
  'THREAT',
  'COMPARISON',
  'MEDICAL_CLAIM',
  'RELIGIOUS_RULING',
  'PII_LEAK',
  'AGE_INAPPROPRIATE',
  'EXTERNAL_ACTION',
  'INJECTION_ECHO',
  'PARENT_DATA_LEAK',
  'ASKS_CHILD_FOR_INFO',
  'TOO_LONG',
] as const;

export type ChildSafetyReason = (typeof CHILD_SAFETY_REASONS)[number];

interface Rule {
  readonly reason: ChildSafetyReason;
  readonly patterns: readonly RegExp[];
}

/**
 * The banned-content lists. Arabic first; each entry is a phrasing this product
 * has decided a child will never be sent, not a guess at what a model might
 * say. CONTEXT §3 principle 7 supplies most of them directly: «ممنوع "تم
 * حظرك" / "ممنوع" / "أنت تجاوزت"».
 *
 * NO `\b` ON AN ARABIC ALTERNATION, AND THE REASON IS NOT STYLE. JavaScript's
 * `\b` is defined over `[A-Za-z0-9_]`, so between a space and an Arabic letter
 * there is NO word boundary and `/\b(?:كسول)\b/` never matches anything. The
 * first draft of this file wrapped every Arabic list in `\b` and the filter
 * silently passed «أنت كسول اليوم» — a shaming sentence, straight to a child,
 * with a green test suite. `child-coach-safety.spec.ts` caught it because it
 * asserts on REAL Arabic sentences rather than on the regex.
 *
 * Arabic entries therefore match as substrings. That is the correct direction
 * for a fail-closed filter: a false positive costs one template instead of one
 * model variation, and a false negative costs a child.
 */
const RULES: readonly Rule[] = Object.freeze([
  {
    reason: 'SHAMING',
    patterns: [
      /(?:كسول|فاشل|مهمل|سيّئ|مدمن|غبي)/i,
      /(?:خذلت|خيّبت|أحبطت)\s+(?:والديك|أهلك|أمك|أباك)/i,
      /\b(?:lazy|failure|useless|stupid|addict)\b/i,
    ],
  },
  {
    reason: 'THREAT',
    patterns: [
      /(?:سيتم|سوف)\s+(?:حظرك|منعك|معاقبتك|حرمانك)/i,
      /(?:تم\s+حظرك|ممنوع\s+عليك|عقابك|ستُعاقب|ستعاقب)/i,
      /(?:سنأخذ|سيأخذ|سنسحب)\s+(?:منك|جهازك|هاتفك)/i,
      /\b(?:you\s+(?:are|will\s+be)\s+(?:blocked|banned|punished)|we\s+will\s+take)\b/i,
    ],
  },
  {
    reason: 'COMPARISON',
    patterns: [
      /(?:أخوك|أختك|أصدقاؤك|زملاؤك|الأطفال\s+الآخرون)\s+.{0,24}(?:أفضل|أحسن|أسرع|أنجز)/i,
      /(?:على\s+عكس|بخلاف)\s+(?:أخيك|أختك|أصدقائك)/i,
      /\b(?:your\s+(?:brother|sister|friends)|other\s+kids)\b.{0,24}\b(?:better|faster)\b/i,
    ],
  },
  {
    reason: 'MEDICAL_CLAIM',
    patterns: [
      /(?:اكتئاب|توحد|فرط\s+الحركة|اضطراب|تشخيص|مرض\s+نفسي|قلق\s+مرضي)/i,
      /(?:أنت\s+تعاني\s+من|لديك\s+حالة)/i,
      /\b(?:ADHD|autis|depress|diagnos|disorder)/i,
    ],
  },
  {
    reason: 'RELIGIOUS_RULING',
    patterns: [/(?:حرام|حلال|إثم|معصية)/i, /(?:فتوى|حكم\s+شرعي)/i],
  },
  {
    reason: 'EXTERNAL_ACTION',
    patterns: [
      /https?:\/\//i,
      /(?:اتصل|كلّم|راسل|أرسل\s+رسالة)\s+(?:بـ|ب)?(?:رقم|شخص|أحد)/i,
      /\b(?:whatsapp|telegram|instagram|tiktok|snapchat)\b/i,
      /(?:قابل|التقِ|اذهب\s+إلى)\s+.{0,20}(?:شخص|صديق\s+جديد)/i,
    ],
  },
  {
    reason: 'PARENT_DATA_LEAK',
    patterns: [
      /(?:اشتراك|فاتورة|يدفع|الدفع|بطاقة|رصيد)\s+(?:والدك|أبيك|أمك|والديك)/i,
      /(?:كلمة\s+مرور|بريد)\s+(?:والدك|والديك)/i,
      /\b(?:parent'?s?\s+(?:password|email|subscription|payment|card))\b/i,
    ],
  },
  {
    reason: 'ASKS_CHILD_FOR_INFO',
    patterns: [
      /(?:ما\s+هو|أخبرني\s+بـ?)\s*(?:عنوانك|رقمك|مدرستك|كلمة\s+مرورك|اسم\s+أبيك)/i,
      /\b(?:what'?s?\s+your\s+(?:address|phone|school|password))\b/i,
    ],
  },
  {
    reason: 'PII_LEAK',
    patterns: [
      /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
      /\+?[0-9][0-9\s().-]{8,}[0-9]/,
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
    ],
  },
]);

/**
 * B8 — THE OUTPUT SAFETY FILTER FOR CHILD-FACING TEXT.
 *
 * WHY IT IS A SEPARATE SERVICE FROM `SafetyEngineService`, and not an extra
 * method on it: they answer different questions and fail in opposite
 * directions. `SafetyEngineService` validates a PARENT-facing recommendation
 * against this project's no-spyware principle and knows nothing about age. This
 * one validates a CHILD-facing sentence against a banned-content list, a
 * per-age-band length ceiling, and an injection-echo check — and it is
 * FAIL-CLOSED (§11.2): anything it cannot vouch for is replaced by the
 * human-written template, and the child sees no error at any point.
 *
 * IT VALIDATES TEMPLATES TOO, NOT ONLY MODEL OUTPUT. A rule that only ran on
 * LLM output would be a rule that trusts whoever writes the template library,
 * and `child-safety-filter.service.spec.ts` asserts that every one of the 4×4
 * encouragement templates and all 9×4 topic answers pass their own band's
 * ceiling. A human-written line that is too long for a six-year-old is still
 * too long for a six-year-old.
 */
@Injectable()
export class ChildSafetyFilterService {
  private readonly logger = new Logger(ChildSafetyFilterService.name);

  validate(text: string, band: AgeBand, limits?: ChildSafetyLimits): ChildSafetyResult {
    const reasons: ChildSafetyReason[] = [];
    const profile = ageBandProfile(band);
    const charCeiling = limits?.maxChars ?? profile.maxChars;
    const wordCeiling = limits?.maxWords ?? profile.maxWords;

    if (!text.trim()) {
      return { isSafe: false, reasons: ['TOO_LONG'] };
    }

    if (text.length > charCeiling || countWords(text) > wordCeiling) {
      reasons.push('TOO_LONG');
    }

    // INJECTION_ECHO: the model repeating back an override attempt, or leaking
    // our own envelope markers into a child's screen. Either one means the
    // prompt boundary did not hold and the output must not ship.
    if (detectInjection(text) || text.includes(UNTRUSTED_OPEN) || text.includes(UNTRUSTED_CLOSE)) {
      reasons.push('INJECTION_ECHO');
    }

    for (const rule of RULES) {
      if (rule.patterns.some((p) => p.test(text))) reasons.push(rule.reason);
    }

    if (reasons.length > 0) {
      // The REASONS are logged, never the text: a rejected child-facing string
      // may itself contain whatever tripped the filter.
      this.logger.warn(JSON.stringify({ event: 'child_safety_reject', band, reasons }));
    }

    return { isSafe: reasons.length === 0, reasons: Object.freeze(reasons) };
  }

  /**
   * FAIL-CLOSED, EXPRESSED AS A FUNCTION SO NO CALLER CAN FORGET IT.
   * `candidate` is model output; `template` is the human-written line that was
   * already approved. If the candidate does not pass, the template ships. There
   * is no third outcome and no path that returns the candidate unvalidated.
   */
  chooseSafe(
    candidate: string,
    template: string,
    band: AgeBand,
    limits?: ChildSafetyLimits,
  ): { text: string; usedCandidate: boolean } {
    const verdict = this.validate(candidate, band, limits);
    return verdict.isSafe ? { text: candidate, usedCandidate: true } : { text: template, usedCandidate: false };
  }
}
