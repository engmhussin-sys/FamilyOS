/**
 * B8 — THE DISTRESS ESCALATION PATH, AS DATA.
 *
 * 07-AI-Architecture.md §11.4, first line: «المبدأ الحاكم: الموديل لا يرتجل في
 * هذه الحالة إطلاقًا» — the model does not improvise here, at all. Everything
 * this module contains follows from that single sentence:
 *
 *   - The CLASSIFIER is a deterministic keyword scan. No provider call, no
 *     network, no tokens. It runs identically when every provider is down, and
 *     it cannot be made to not-fire by a provider being slow.
 *   - The RESPONSE is a fixed, human-written card. It is a constant in this
 *     file, reviewable in a diff, and it is what the child sees. It is NOT a
 *     template the model fills in and NOT a seed the model rephrases.
 *   - The RAW TEXT IS NEVER STORED and NEVER SENT ANYWHERE. `classify` takes a
 *     string and returns a CODE. The string is not returned, not logged, not
 *     persisted, and not placed in any prompt. What persists is
 *     `{ code, detectedAt }` in `ai_memory_entries` — the only AI-writable
 *     table that can hold it.
 *   - The PARENT ALERT is generically worded («قد يحتاج … لحديث معك اليوم»)
 *     and quotes nothing.
 *
 * SENSITIVITY IS TUNED FOR RECALL, ON PURPOSE (§11.4). A false positive costs a
 * parent one gentle notification. A false negative costs something this project
 * is not willing to price. The list below therefore includes phrasings that are
 * frequently ordinary teenage hyperbole; that is a deliberate, stated trade.
 *
 * THIS IS A PRODUCT SAFETY PATH, NOT A CRISIS SERVICE. It does not diagnose, it
 * does not advise medically, it does not promise confidentiality, and it is not
 * a substitute for professional care. The helpline directory below is a
 * PLACEHOLDER pending per-market review by a child psychologist — an explicit
 * launch gate (§13 R-8), restated in this file so nobody ships it by accident.
 */

export type DistressCode =
  | 'SELF_HARM'
  | 'HOPELESSNESS'
  | 'ABUSE_OR_FEAR'
  | 'BULLYING'
  | 'SEVERE_SADNESS';

export interface DistressSignal {
  readonly detected: true;
  readonly code: DistressCode;
}

export interface NoDistressSignal {
  readonly detected: false;
}

export type DistressClassification = DistressSignal | NoDistressSignal;

/**
 * Ordered most-severe first: `classify` returns the FIRST match, so a message
 * containing both a self-harm phrase and a bullying phrase escalates as
 * self-harm rather than as whichever pattern happened to be listed first.
 */
const DISTRESS_RULES: readonly { readonly code: DistressCode; readonly patterns: readonly RegExp[] }[] =
  Object.freeze([
    {
      code: 'SELF_HARM',
      patterns: [
        /(?:أريد|عايز|بدي|نفسي)\s+(?:أن\s+)?(?:أموت|اموت|أنهي\s+حياتي|انهي\s+حياتي)/i,
        /(?:أؤذي|اؤذي|أجرح|اجرح)\s+نفسي/i,
        /(?:لا\s+أريد|مش\s+عايز|ما\s+ابي)\s+(?:أن\s+)?(?:أعيش|اعيش|أكمل|اكمل)/i,
        /(?:أنهي|انهي)\s+كل\s+شيء/i,
        /\b(?:kill|hurt|cut)\s+myself\b/i,
        /\b(?:want|going)\s+to\s+die\b/i,
        /\bend\s+(?:it\s+all|my\s+life)\b/i,
        /\bsuicid/i,
      ],
    },
    {
      code: 'ABUSE_OR_FEAR',
      patterns: [
        /(?:يضربني|تضربني|يضربونني|بيضربني)/i,
        /(?:خائف|خايف|أخاف|اخاف)\s+(?:من\s+)?(?:أبي|امي|أمي|البيت|الرجوع)/i,
        /(?:يلمسني|تلمسني|لمسني)\s+(?:أحد|حد|شخص)/i,
        /\b(?:hits?|beats?|hurts?)\s+me\b/i,
        /\bafraid\s+to\s+go\s+home\b/i,
        /\btouched\s+me\b/i,
      ],
    },
    {
      code: 'HOPELESSNESS',
      patterns: [
        /(?:لا\s+فائدة|مافي\s+فايدة|مفيش\s+فايدة)\s+(?:من|في)?\s*(?:أي\s+)?(?:شيء|حاجة)?/i,
        /(?:لا\s+أحد|محدش|ما\s+حد)\s+(?:يهتم|يحبني|بيحبني)/i,
        /(?:أكره|اكره)\s+(?:نفسي|حياتي)/i,
        /(?:الجميع|كلهم)\s+(?:أفضل|احسن|أحسن)\s+(?:بدوني|من\s+غيري)/i,
        /\bnobody\s+(?:cares|loves\s+me)\b/i,
        /\bhate\s+(?:myself|my\s+life)\b/i,
        /\b(?:everyone|they)\s+(?:would\s+be|are)\s+better\s+off\s+without\s+me\b/i,
        /\bno\s+point\s+(?:in\s+)?(?:anything|living)\b/i,
      ],
    },
    {
      code: 'BULLYING',
      patterns: [
        /(?:يتنمرون|بيتنمروا|يسخرون|بيضحكوا)\s+(?:علي|عليّ|مني)/i,
        /(?:يضايقونني|بيضايقوني|يزعجونني)\s+في\s+المدرسة/i,
        /\bbull(?:y|ies|ying)\s+me\b/i,
        /\bthey\s+(?:make\s+fun\s+of|laugh\s+at)\s+me\b/i,
      ],
    },
    {
      code: 'SEVERE_SADNESS',
      patterns: [
        /(?:حزين|حزينة)\s+(?:جدا|جدًا|أوي|قوي)/i,
        /(?:أبكي|ابكي|بعيط)\s+(?:كل\s+)?(?:يوم|ليلة|الوقت)/i,
        /(?:وحيد|وحيدة|لوحدي)\s+(?:دائما|دائمًا|طول\s+الوقت)/i,
        /\bcry(?:ing)?\s+every\s+(?:day|night)\b/i,
        /\b(?:so|really)\s+(?:sad|lonely|depressed)\b/i,
      ],
    },
  ]);

/**
 * TAKES TEXT, RETURNS A CODE. That signature is the privacy control: there is
 * no overload that returns the matched substring, no `reason` field carrying a
 * quote, and no logging inside this function. A caller cannot accidentally
 * persist what the child wrote because this function never hands it back.
 */
export function classifyDistress(freeText: string): DistressClassification {
  if (!freeText || !freeText.trim()) return { detected: false };
  for (const rule of DISTRESS_RULES) {
    if (rule.patterns.some((p) => p.test(freeText))) {
      return { detected: true, code: rule.code };
    }
  }
  return { detected: false };
}

export interface DistressResponseCard {
  readonly titleAr: string;
  readonly bodyAr: string;
  readonly helplines: readonly { readonly country: 'EG' | 'SA'; readonly labelAr: string; readonly number: string }[];
  /** Always true. Present in the payload so a client cannot render this card as
   * if it were coach output, and so a test can assert it. */
  readonly humanWritten: true;
}

/**
 * THE ONE CARD. Same text for every code and every age band — deliberately.
 * Branching this by severity would mean the product silently telling a child
 * how serious it judged their words to be, which is exactly the diagnosis §11.4
 * forbids. The band-specific vocabulary rules do not apply here either: this
 * sentence was written by a human for all four bands, and the safety filter
 * exempts it by identity, not by re-checking its length.
 */
export const DISTRESS_RESPONSE_CARD: DistressResponseCard = Object.freeze({
  titleAr: 'شكرًا لأنك كتبت هذا',
  bodyAr:
    'ما كتبته مهم، وأنت لست وحدك. أقرب خطوة الآن هي أن تتحدث مع شخص بالغ تثق به — ' +
    'أحد والديك، أو مدرّس، أو قريب تحبه. إن كنت تفضّل التحدث مع شخص خارج البيت، ' +
    'الأرقام أدناه مخصّصة لذلك ويمكنك الاتصال بها.',
  helplines: Object.freeze([
    Object.freeze({ country: 'EG' as const, labelAr: 'خط نجدة الطفل — مصر', number: '16000' }),
    Object.freeze({ country: 'SA' as const, labelAr: 'خط الأمان الأسري — السعودية', number: '1919' }),
  ]),
  humanWritten: true,
});

/**
 * The parent alert copy. Generic by design (§11.4): it names the child, states
 * that a conversation would help today, and says nothing else. It quotes
 * nothing, classifies nothing to the parent, and is identical for every
 * `DistressCode` for the same reason the card is.
 */
export function distressParentAlert(childFirstName: string): { title: string; body: string } {
  return {
    title: 'وقت مناسب لحديث قصير',
    body: `قد يحتاج ${childFirstName} لحديث معك اليوم. اجلس معه وقتًا قصيرًا واسأله كيف كان يومه.`,
  };
}

/** `ai_memory_entries.category` for the stored signal. Code and time only. */
export const DISTRESS_MEMORY_CATEGORY = 'DISTRESS_SIGNAL';

// ===========================================================================
// THE `ai_alerts` ROW — THE DURABLE, PARENT-READABLE RECORD OF THE SAME EVENT
// ===========================================================================

/**
 * `ai_alerts.source_module`. Names the subsystem, not the classifier's verdict.
 */
export const DISTRESS_ALERT_SOURCE_MODULE = 'ai-core.distress-escalation';

/**
 * ONE CATEGORY AND ONE SEVERITY FOR ALL FIVE CODES, AND THE CHOICE IS THE
 * PRIVACY CONTROL — read this before "improving" it into a severity ladder.
 *
 * The tempting design is a mapping: SELF_HARM ⇒ CRITICAL, BULLYING ⇒ HIGH,
 * SEVERE_SADNESS ⇒ MEDIUM, and a category per code. It was written, measured
 * against §11.4, and REJECTED — because `(category, severity)` would then be a
 * BIJECTION onto `DistressCode`. A parent reading two enum values off the alert
 * list would recover the exact classification, which is the diagnosis §11.4
 * forbids this product from delivering («the parent is not told our severity
 * judgement», already asserted in `distress-escalation.spec.ts` about the
 * notification copy). A row nobody can reverse-read is worth more than a
 * severity ladder nobody asked for.
 *
 * SO: CRITICAL, ALWAYS. It is also the honest reading of the rule on the other
 * end of this table — `GrowthAlertsService.aiSafetyIncident`: «AN AI SAFETY
 * INCIDENT IS NOT A THRESHOLD. One is one too many, so this rule has no
 * configurable count.» A distress signal that arrived at CRITICAL is the one
 * that rule was written to see; anything lower would have made the reader
 * dormant a second time, in a subtler way.
 *
 * THE COST IS STATED RATHER THAN HIDDEN. §11.4 tunes the classifier for RECALL,
 * so ordinary teenage hyperbole reaches this line and is written CRITICAL too.
 * That is the same trade §11.4 already made and already priced: a false
 * positive costs a parent one gentle notification and an operator one page; a
 * false negative costs something this project is not willing to price.
 *
 * HEALTH, and not the other four. `DIGITAL_SAFETY` would be a lie — nothing
 * digital was monitored; a child volunteered how they feel on a check-in
 * screen. `BEHAVIOR` would frame a child who wrote «يضربني» as the one
 * behaving. `EDUCATION` and `LOCATION` are unrelated. `HEALTH` is this enum's
 * wellbeing bucket and it is where a parent looks for this.
 */
export const DISTRESS_ALERT_CATEGORY = 'HEALTH';
export const DISTRESS_ALERT_SEVERITY = 'CRITICAL';

/**
 * THE ROW'S PARENT-FACING TEXT. Human-written, Arabic-first, frozen, and
 * IDENTICAL for every `DistressCode` — for the same reason
 * `DISTRESS_RESPONSE_CARD` and `distressParentAlert` are.
 *
 * IT CARRIES NO CHILD'S NAME EITHER, and that is a second decision rather than
 * an oversight: `ai_alerts.child_id` already identifies the child, the read
 * side resolves the first name through the `child` relation at query time, and
 * copying a name into a text column would spread a child's PII into a third
 * table for no gain. The last sentence tells the parent, in the alert itself,
 * that this product is not going to show them what their child wrote.
 */
export const DISTRESS_ALERT_COPY = Object.freeze({
  title: 'إشارة تستحق اطمئنانك اليوم',
  description:
    'ظهرت إشارة من طفلك اليوم تستحق انتباهك. اجلس معه وقتًا قصيرًا واسأله كيف كان يومه. ' +
    'لا يعرض هذا التنبيه ما كتبه طفلك.',
});

/**
 * `ai_alerts.source_event_id` — what makes this alert THE SAME ALERT.
 *
 * ONE ALERT PER CHILD PER FAMILY BUSINESS DAY. The same discriminator the
 * parent notification already uses, and for the identical product reason
 * stated at that call site: a second signal on the same day is the same
 * conversation, and telling a parent twice in one evening adds pressure
 * without adding information.
 *
 * IT IS A CALENDAR DAY AND NOT A FIVE-MINUTE BUCKET. `forRecurringSignal`'s own
 * docstring is honest that a bucket boundary is not a sliding window — two
 * identical signals thirty seconds apart on opposite sides of an edge produce
 * two keys. For a transient notification that is an acceptable backstop; for a
 * DURABLE row a parent scrolls through it would be visible duplication. The
 * family's business date, resolved through `FamilyDateService`, has no edge a
 * replay can land on.
 *
 * THE CODE IS NOT IN THE KEY. It would be the one place the classification
 * survived into a stored column, and `growth_alerts`' own message says it in
 * Arabic: «لا تُنقل أي تفاصيل عن الطفل إلى هذا الجدول». The consequence is
 * accepted and named: a day whose first signal was BULLYING and whose second is
 * SELF_HARM produces ONE row, and because every code is written CRITICAL the
 * severity of that row is already the severity the second signal deserves.
 */
export function distressAlertSourceEventId(childId: string, businessDate: string): string {
  return `distress:${childId}:${businessDate}`;
}
