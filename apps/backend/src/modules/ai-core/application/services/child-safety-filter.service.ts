import { Injectable, Logger } from '@nestjs/common';

import { ageBandProfile, countWords, type AgeBand } from '../../domain/age-band';
import { matchesAnyVariant, textVariants } from '../../domain/arabic-normalise';
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
      // `سيئ` AND NOT `سيّئ`. The entry was written with a shadda, and the
      // shadda is optional in real Arabic writing — so the ordinary spelling
      // walked straight past it (`e2e-15` GAP-1). It is spelled here WITHOUT
      // the shadda and the normalised pass in `validate` folds the other one
      // onto it, which is the general fix rather than the second literal.
      /(?:كسول|كسلان|فاشل|مهمل|سيئ|مدمن|غبي)/i,
      // EGYPTIAN, because half this product's children are in Cairo and the
      // list above was Modern Standard Arabic only (`e2e-15` GAP-2). Terms that
      // are substrings of ordinary words are deliberately absent: `وحش` would
      // have banned «وحشتني» (I missed you), which is affection.
      /(?:أهبل|اهبل|عبيط|مغفل|بليد|تافه|بايخ|خايب|زفت|حقير|مالكش\s+لازمة)/i,
      /(?:خذلت|خيّبت|أحبطت)\s+(?:والديك|أهلك|أمك|أباك)/i,
      /\b(?:lazy|failure|useless|stupid|addict)\b/i,
    ],
  },
  /**
   * SELF-HARM AND HOPELESSNESS, ON THE WAY *OUT*.
   *
   * `distress.ts` classifies what a CHILD writes and routes it to a
   * human-written card. It has nothing to say about what a MODEL writes, and
   * until `e2e-15` GAP-5 measured it, this filter had no rule in this category
   * at all: «أنت لا تستحق الحياة» — you do not deserve to live — was returned
   * `isSafe: true` at all four bands and stored as a message to a child.
   *
   * WHY THE REASON IS `SHAMING` AND NOT A NEW CODE. `CHILD_SAFETY_REASONS` is a
   * closed enum that a `copy_safety_check` dashboard counts, and `e2e-15` pins
   * `SHAMING` for this string. A distinct `SELF_HARM_ECHO` code would be worth
   * having for alerting and is a deliberate follow-up, not a silent change to a
   * published reason set. The child-facing OUTCOME is identical either way: the
   * sentence never ships and the human-written template does.
   *
   * THE NARROW SHAPE IS THE POINT. Every pattern here names its object.
   * «لا تستحق» is refused only in front of «الحياة»; «أنت لا تحتاج إلى القلق»
   * is ordinary negation and stays green, as `child-coach-safety.spec.ts`
   * asserts. `نفسك` alone is not a trigger either — the REST template «ابدأ
   * اليوم، ولا تحاسب نفسك على أمس» contains it and must keep shipping.
   */
  {
    reason: 'SHAMING',
    patterns: [
      /لا\s+تستحق\s+(?:الحياة|الحياه|أن\s+تعيش|ان\s+تعيش|العيش|الحب|شيئا|شيئًا|النجاح)/i,
      /(?:أنت|انت|إنت)\s+(?:بلا|من\s+غير)\s+(?:فائدة|قيمة|أمل)/i,
      /(?:حياتك|وجودك)\s+(?:بلا\s+معنى|بلا\s+قيمة|لا\s+معنى\s+لها|لا\s+قيمة\s+لها)/i,
      /(?:لا\s+أحد|لا\s+احد|محدش|ما\s+حد|مافي\s+أحد)\s+(?:يحبك|بيحبك|يهتم\s+بك|يفتقدك|يريدك)/i,
      /(?:الجميع|كلهم|العالم|أهلك)\s+(?:أفضل|أحسن|احسن|مرتاح\S*)\s+(?:بدونك|من\s+غيرك)/i,
      /(?:آذِ|أذِ|اذِ|اجرح|أجرح|اقطع|اضرب|اؤذ|أؤذ)\S*\s+نفسك/i,
      /(?:تؤذي|تجرح|تضرب|تقطع)\s+نفسك/i,
      /(?:انتحر|الانتحار|تنتحر)/i,
      /(?:من\s+الأفضل|الأفضل)\s+(?:لك\s+)?أن\s+(?:تختفي|ترحل|تموت)/i,
      /\byou\s+(?:don'?t|do\s+not)\s+deserve\s+to\s+(?:live|be\s+here|exist)\b/i,
      /\b(?:kill|hurt|harm|cut)\s+yourself\b/i,
      /\bnobody\s+(?:loves|cares\s+about|needs)\s+you\b/i,
      /\b(?:worthless|better\s+off\s+without\s+you)\b/i,
      /\bend\s+your\s+life\b/i,
    ],
  },
  {
    reason: 'THREAT',
    patterns: [
      /(?:سيتم|سوف)\s+(?:حظرك|منعك|معاقبتك|حرمانك)/i,
      /(?:تم\s+حظرك|ممنوع\s+عليك|عقابك|ستُعاقب|ستعاقب)/i,
      // MSA future is `سنسحب`; Egyptian and Gulf say `بنسحب` / `هنسحب` /
      // `حنسحب` and mean today, not tomorrow (`e2e-15` GAP-3). A threat in the
      // register a child actually reads is still a threat.
      /(?:سنأخذ|سيأخذ|سنسحب|بنسحب|هنسحب|حنسحب|بنأخذ|هنأخذ|هناخد|بناخد|حناخذ|هنشيل|بنشيل)\s+(?:منك|جهازك|هاتفك|التابلت|الجهاز)/i,
      /(?:هنحرمك|حنحرمك|بنحرمك|هتتحرم|حتتحرم|هتتعاقب|حتتعاقب|هنمنعك|بنمنعك|هنقفل\s+عليك)/i,
      /\b(?:you\s+(?:are|will\s+be)\s+(?:blocked|banned|punished)|we\s+will\s+take)\b/i,
    ],
  },
  /**
   * THE HARM IS THE COMPARISON, NOT THE NOUN.
   *
   * `أخوك` must never become a banned word: «أخوك يحبك كثيرًا» is a sentence
   * this product wants to be able to send. Both patterns below therefore
   * require a SECOND element — a ranking verb, or the Egyptian contrast
   * «…وإنت لأ» — within a short window of the sibling. `e2e-15` GAP-4 was the
   * verb list being MSA-only: «أخوك خلص كل حاجة وإنت لأ» ranked the child
   * against a sibling in words the MSA list could not see.
   */
  {
    reason: 'COMPARISON',
    patterns: [
      /(?:أخوك|أخوكي|اخوك|أختك|اختك|أصدقاؤك|أصحابك|صحابك|زملاؤك|زمايلك|الأطفال\s+الآخرون|باقي\s+الأولاد)\s+.{0,24}(?:أفضل|أحسن|احسن|أسرع|أنجز|انجز|خلص|خلّص|كمّل|كمل|سبقك|أشطر|اشطر)/i,
      // The contrast is spelled out and it is the whole insult. Kept to the
      // strong Egyptian forms — `وأنت لا` was NOT included, because «أخوك سعيد
      // بك وأنت لا تعرف» is ordinary Arabic and this filter is not a wall.
      /(?:أخوك|اخوك|أختك|اختك|أصدقاؤك|صحابك|زمايلك)\s+.{0,30}(?:وإنت|وانت|وأنت)\s+(?:لأ|مش|ماعملتش|لسه|مافيش)/i,
      /(?:على\s+عكس|بخلاف)\s+(?:أخيك|أختك|أصدقائك)/i,
      /\b(?:your\s+(?:brother|sister|friends)|other\s+kids)\b.{0,24}\b(?:better|faster)\b/i,
    ],
  },
  /**
   * AGE_INAPPROPRIATE — DECLARED SINCE THE FIRST DRAFT, PRODUCED BY NOTHING.
   *
   * `e2e-15` GAP-6: the reason sat in `CHILD_SAFETY_REASONS` while no rule in
   * this file could ever emit it, so «جرب تدخن سيجارة مع صحابك» — try smoking a
   * cigarette with your friends — was `isSafe: true` for a six-year-old. An
   * enum member with no rule behind it is worse than no enum member: it reads,
   * on a dashboard and in a review, as a category that is covered.
   *
   * SUBSTRING MATCHING IS WHY THIS LIST IS SHORT. `بيرة` (beer) is a substring
   * of «كبيرة» (big) — «خطوة كبيرة اليوم» would have been refused — and `سلاح`
   * is a substring of the ordinary motivational metaphor «سلاحك السري هو
   * التركيز». Both are absent on purpose; a rule that eats those sentences
   * costs a child their coach line every time.
   */
  {
    reason: 'AGE_INAPPROPRIATE',
    patterns: [
      /(?:سيجارة|سيجاره|سجائر|تدخن|تدخين|شيشة|شيشه|معسل|فيب)/i,
      /(?:خمر|كحول|نبيذ|مسكر)/i,
      /(?:مخدرات|حشيش|ترامادول|حبوب\s+منومة)/i,
      /(?:مراهنة|رهان|قمار|كازينو)/i,
      /(?:إباحي|اباحي|مقاطع\s+جنسية|علاقة\s+جنسية|مواعدة)/i,
      /(?:مسدس|سلاح\s+ناري)/i,
      /(?:اهرب\s+من\s+(?:البيت|المنزل)|اكذب\s+على\s+(?:والديك|أهلك)|اكذب\s+علي\s+(?:والديك|أهلك))/i,
      /\b(?:cigarettes?|smoking|smoke\s+a|vap(?:e|ing)|alcohol|whisky|gambl(?:e|ing)|casino|porn|drugs)\b/i,
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
      // STILL ASCII `[0-9]`, AND THAT IS NOW CORRECT. `prompt-safety.ts:97`
      // spells its phone shape `[\d٠-٩]` and this one did not, so «ابعتلي رقمك
      // ٠١٠١٢٣٤٥٦٧٨» was PII to one filter and prose to the other (`e2e-15`
      // GAP-7). The fix is upstream: `validate` folds Arabic-Indic digits to
      // ASCII before matching, so ONE shape covers both scripts and the two
      // filters cannot drift apart again by a script the next person forgets.
      // The 10-character floor is what keeps «حصلت على ٥٠ نقطة» legible.
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

    // THE CEILINGS ARE MEASURED ON THE ORIGINAL BYTES, NOT THE NORMALISED
    // COPY — those are the bytes a child's screen has to fit.
    if (text.length > charCeiling || countWords(text) > wordCeiling) {
      reasons.push('TOO_LONG');
    }

    // INJECTION_ECHO: the model repeating back an override attempt, or leaking
    // our own envelope markers into a child's screen. Either one means the
    // prompt boundary did not hold and the output must not ship.
    if (detectInjection(text) || text.includes(UNTRUSTED_OPEN) || text.includes(UNTRUSTED_CLOSE)) {
      reasons.push('INJECTION_ECHO');
    }

    // EVERY LIST IS MATCHED AGAINST THE ORIGINAL TEXT *AND* ITS NORMALISED
    // FORM. `e2e-15` found three separate holes — a shadda (GAP-1), Arabic-Indic
    // digits (GAP-7) and a missing hamza (GAP-9) — that were one hole: a list of
    // literal spellings cannot enumerate Arabic orthography. Matching the union
    // is purely additive, so no rule that fired before can stop firing, and it
    // closes the whole class instead of the three strings that were measured.
    //
    // `variants` is a DECISION artefact. Nothing below returns it, stores it, or
    // logs it; `chooseSafe` still ships the candidate's original bytes, which is
    // what `e2e-15` ACT I asserts byte-for-byte out of `child_messages`.
    const variants = textVariants(text);
    for (const rule of RULES) {
      if (rule.patterns.some((p) => matchesAnyVariant(p, variants))) reasons.push(rule.reason);
    }

    // DEDUPED, because `SHAMING` is now produced by two rules — the insult
    // vocabulary and the self-harm group — and a sentence that trips both is
    // one refusal, not two. A dashboard that counted it twice would report a
    // rate this filter does not have.
    const distinct = Object.freeze([...new Set(reasons)]);

    if (distinct.length > 0) {
      // The REASONS are logged, never the text: a rejected child-facing string
      // may itself contain whatever tripped the filter.
      this.logger.warn(JSON.stringify({ event: 'child_safety_reject', band, reasons: distinct }));
    }

    return { isSafe: distinct.length === 0, reasons: distinct };
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
