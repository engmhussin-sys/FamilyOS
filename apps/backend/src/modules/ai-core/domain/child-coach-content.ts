/**
 * B8 — THE CHILD-FACING CONTENT LIBRARY.
 *
 * THE DECISION THIS FILE ENCODES, RESTATED SO IT IS NOT LOST IN A REFACTOR:
 * **there is no open-ended chat with a child in this product** (§11.1). That is
 * a product decision with four written reasons, not a technical limitation, and
 * B8 keeps it. What B8 adds is bounded, and the bound is this file:
 *
 *   - ENCOURAGEMENT: a deterministic intent (CELEBRATE | NUDGE | RESTART |
 *     REST) chosen by rules from the child's real numbers, then a HUMAN-WRITTEN
 *     template for that intent × age band. A provider, if configured, may
 *     rephrase the chosen template and may do nothing else; its output is
 *     discarded unless it passes the safety filter (fail-closed, §11.2).
 *
 *   - ANSWERS: a CLOSED VOCABULARY of topic codes. The child's app renders
 *     buttons; the child picks one; the backend returns the human-written
 *     answer for that code and their age band. **No child free text is ever
 *     placed in any prompt on this path, because there is no child free text on
 *     this path.** `GET /self/coach/answer/:topicCode` validates the code
 *     against `CHILD_TOPIC_CODES` and 400s on anything else — a code is an enum
 *     member, not a string that reaches a model.
 *
 * WHAT WAS GATED, EXACTLY (the honest answer to "did you extend it?"):
 * before B8 a child had no AI-adjacent surface at all beyond approved
 * notifications. B8 adds two READ endpoints and one WRITE endpoint, and each is
 * bounded here rather than by a prompt instruction:
 *   1. `GET /self/coach/today`          → template library, no child input.
 *   2. `GET /self/coach/answer/:code`   → closed enum, no child input.
 *   3. `POST /self/coach/checkin`       → free text, and the ONLY free text a
 *      child can send. It is classified OFFLINE by `classifyDistress` and is
 *      never stored, never logged, and never sent to any provider. There is no
 *      code path from that field to `IAIProvider.complete`, and
 *      `child-coach-no-free-text.spec.ts` fails if one is ever added.
 */

import type { AgeBand } from './age-band';

export type EncouragementIntent = 'CELEBRATE' | 'NUDGE' | 'RESTART' | 'REST';

export const ENCOURAGEMENT_INTENTS: readonly EncouragementIntent[] = Object.freeze([
  'CELEBRATE',
  'NUDGE',
  'RESTART',
  'REST',
]);

/**
 * §11.3's register per band, applied. Every line is inside its band's word
 * ceiling, contains no number the caller did not supply, no comparison to a
 * sibling or peer, no threat, and no request for information from the child.
 * `{n}` is the ONLY substitution and it is always a non-negative integer the
 * server computed.
 */
const ENCOURAGEMENT: Readonly<Record<EncouragementIntent, Readonly<Record<AgeBand, readonly string[]>>>> =
  Object.freeze({
    CELEBRATE: Object.freeze({
      '6-8': Object.freeze(['أحسنت! أكملت مهمتك اليوم.', 'رائع! أنت تكبر كل يوم.', 'عمل جميل اليوم.']),
      '9-11': Object.freeze([
        'أكملت {n} أيام متتالية. استمر.',
        'يومك اليوم كان ممتازًا، وأنت من صنعه.',
        'تقدّمك واضح هذا الأسبوع.',
      ]),
      '12-14': Object.freeze([
        'أنجزت ما خططت له اليوم. هذا يُحسب لك.',
        '{n} أيام متتالية — التزام حقيقي.',
        'أسبوع قوي. أنت تعرف كيف تفعلها.',
      ]),
      '15-17': Object.freeze([
        'أنجزت ما قررته. هذا كل ما في الأمر.',
        '{n} يومًا متتاليًا. الانضباط يظهر في الأرقام.',
        'أداؤك هذا الأسبوع أعلى من المعتاد.',
      ]),
    }),
    NUDGE: Object.freeze({
      '6-8': Object.freeze(['بقيت مهمة واحدة اليوم.', 'هيا نكمل مهمة صغيرة الآن.', 'مهمتك تنتظرك.']),
      '9-11': Object.freeze([
        'ما زال أمامك وقت لإنهاء مهمة اليوم.',
        'مهمة واحدة تفصلك عن يوم مكتمل.',
        'ابدأ بالمهمة الأسهل الآن.',
      ]),
      '12-14': Object.freeze([
        'يومك ما زال مفتوحًا. مهمة واحدة تكفي.',
        'لو بدأت الآن، ستنهيها قبل المساء.',
        'خطوة صغيرة الآن أفضل من خطة كبيرة غدًا.',
      ]),
      '15-17': Object.freeze([
        'ما زال هناك وقت اليوم. اختر مهمة واحدة وابدأ.',
        'أقصر طريق لإنهاء اليوم هو أن تبدأ الآن.',
        'مهمة واحدة، ثم استرح.',
      ]),
    }),
    RESTART: Object.freeze({
      '6-8': Object.freeze(['لا بأس. نبدأ من جديد اليوم.', 'كل يوم بداية جديدة.', 'جرّب مرة أخرى اليوم.']),
      '9-11': Object.freeze([
        'انقطعت السلسلة، والبداية الجديدة تبدأ اليوم.',
        'يوم واحد لا يلغي ما قبله. أكمل.',
        'ابدأ من جديد — رقمك السابق ما زال ملكك.',
      ]),
      '12-14': Object.freeze([
        'قررت البدء من جديد. هذا هو الأهم.',
        'التوقف جزء من الطريق. أهم شيء أنك عدت.',
        'ابدأ اليوم، ولا تحاسب نفسك على أمس.',
      ]),
      '15-17': Object.freeze([
        'أسبوع أثقل من المعتاد. الهدف ما زال في متناولك.',
        'العودة بعد انقطاع أصعب من الاستمرار، وأنت تفعلها.',
        'ابدأ من اليوم. الباقي تفاصيل.',
      ]),
    }),
    REST: Object.freeze({
      '6-8': Object.freeze(['أنهيت كل شيء. استرح الآن.', 'يومك انتهى. وقت اللعب.', 'أحسنت. خذ راحتك.']),
      '9-11': Object.freeze([
        'أنهيت مهام اليوم. الراحة جزء من الخطة.',
        'لا شيء متبقٍ اليوم. استمتع بوقتك.',
        'يوم مكتمل. استرح.',
      ]),
      '12-14': Object.freeze([
        'أنهيت ما عليك اليوم. الراحة مستحقة.',
        'لا مهام متبقية. الوقت وقتك.',
        'يوم مكتمل — خذ راحتك بلا ذنب.',
      ]),
      '15-17': Object.freeze([
        'أنهيت اليوم. الراحة ليست تقصيرًا.',
        'لا شيء متبقٍ. أغلق اليوم واسترح.',
        'يوم مكتمل. الوقت الباقي لك.',
      ]),
    }),
  });

/**
 * Deterministic template selection — `pick` is an index derived by the caller
 * from stable inputs (child id + business date), never `Math.random()`. The
 * same child on the same day sees the same line, which is what makes the
 * endpoint idempotent and the output reviewable.
 */
export function encouragementTemplate(intent: EncouragementIntent, band: AgeBand, pick: number, n: number): string {
  const options = ENCOURAGEMENT[intent][band];
  const chosen = options[Math.abs(pick) % options.length];
  return chosen.replace('{n}', String(Math.max(0, Math.trunc(n))));
}

/** Exported for the coverage test: 4 intents × 4 bands, none empty. */
export const ENCOURAGEMENT_LIBRARY = ENCOURAGEMENT;

// ---------------------------------------------------------------------------
// THE CLOSED QUESTION VOCABULARY
// ---------------------------------------------------------------------------

export const CHILD_TOPIC_CODES = [
  'WHAT_IS_A_TASK',
  'HOW_DO_I_START_A_TASK',
  'HOW_DO_POINTS_WORK',
  'WHAT_IS_A_STREAK',
  'WHY_IS_THERE_A_SCREEN_LIMIT',
  'WHY_WAS_MY_TASK_NOT_ACCEPTED',
  'HOW_DO_I_MEMORISE_BETTER',
  'HOW_DO_I_FOCUS_WHILE_STUDYING',
  'WHAT_IF_I_MISS_A_DAY',
] as const;

export type ChildTopicCode = (typeof CHILD_TOPIC_CODES)[number];

export interface ChildTopic {
  readonly code: ChildTopicCode;
  readonly questionAr: string;
}

interface ChildTopicEntry extends ChildTopic {
  readonly answers: Readonly<Record<AgeBand, string>>;
}

/**
 * Every answer below is human-written, non-punitive (CONTEXT §3 principle 7),
 * free of medical or psychological claims, and free of any instruction to act
 * outside the app. There is no link, no "tell your parent to…", and no
 * question asked back to the child (§6.2, `child_encouragement/v2.0.0` rule 2).
 */
const TOPICS: readonly ChildTopicEntry[] = Object.freeze([
  Object.freeze({
    code: 'WHAT_IS_A_TASK' as const,
    questionAr: 'ما هي المهمة؟',
    answers: Object.freeze({
      '6-8': 'المهمة شيء صغير تفعله اليوم، مثل قراءة صفحة.',
      '9-11': 'المهمة هدف صغير لليوم، مثل حفظ آيات أو قراءة عشر صفحات.',
      '12-14': 'المهمة هدف يومي محدد ومقاس بوقت أو بكمية، يمكنك إنهاؤه في جلسة واحدة.',
      '15-17': 'المهمة وحدة عمل يومية محددة بوقت أو كمية، صُمّمت لتُنهى في جلسة واحدة.',
    }),
  }),
  Object.freeze({
    code: 'HOW_DO_I_START_A_TASK' as const,
    questionAr: 'كيف أبدأ مهمة؟',
    answers: Object.freeze({
      '6-8': 'اضغط على المهمة، ثم ابدأ. سنعدّ الوقت معك.',
      '9-11': 'افتح المهمة واضغط ابدأ، ثم أرسل ما أنجزته عند الانتهاء.',
      '12-14': 'اختر المهمة، اضغط ابدأ، أنجزها، ثم أرسل الدليل المطلوب لها.',
      '15-17': 'اختر المهمة، ابدأ المؤقّت، أنجزها، ثم أرسل الدليل الذي يطلبه نوع التحقق.',
    }),
  }),
  Object.freeze({
    code: 'HOW_DO_POINTS_WORK' as const,
    questionAr: 'كيف تعمل النقاط؟',
    answers: Object.freeze({
      '6-8': 'تنهي المهمة، فتأخذ نقاطًا. النقاط تُجمع لك.',
      '9-11': 'كل مهمة لها عدد نقاط. تُضاف بعد التحقق من إنجازك، لا قبله.',
      '12-14': 'لكل برنامج عدد نقاط ثابت، ويُضاف إلى رصيدك بعد اعتماد الإنجاز فقط.',
      '15-17': 'النقاط ثابتة لكل برنامج وتُقيَّد في رصيدك بعد اعتماد الإنجاز، ومع السلسلة يزيد المضاعف.',
    }),
  }),
  Object.freeze({
    code: 'WHAT_IS_A_STREAK' as const,
    questionAr: 'ما هي السلسلة؟',
    answers: Object.freeze({
      '6-8': 'السلسلة هي أيامك المتتالية التي أنهيت فيها مهامك.',
      '9-11': 'السلسلة عدد الأيام المتتالية التي أكملت فيها مهمتك، وكلما طالت زادت نقاطك.',
      '12-14': 'السلسلة عدد الأيام المتتالية بلا انقطاع، وهي التي ترفع مضاعف نقاطك.',
      '15-17': 'السلسلة عدد الأيام المتتالية بلا انقطاع؛ طولها يرفع مضاعف النقاط حتى سقف يحدده البرنامج.',
    }),
  }),
  Object.freeze({
    code: 'WHY_IS_THERE_A_SCREEN_LIMIT' as const,
    questionAr: 'لماذا هناك حد لوقت الشاشة؟',
    answers: Object.freeze({
      '6-8': 'حتى يبقى في يومك وقت للعب والنوم أيضًا.',
      '9-11': 'ليبقى في يومك وقت للحركة والنوم والأشياء الأخرى التي تحبها.',
      '12-14': 'الحد اتفاق أسري لتوزيع وقتك، وليس عقابًا. يمكنك مناقشته مع والديك.',
      '15-17': 'الحد اتفاق أسري على توزيع الوقت، قابل للنقاش والتعديل مع والديك.',
    }),
  }),
  Object.freeze({
    code: 'WHY_WAS_MY_TASK_NOT_ACCEPTED' as const,
    questionAr: 'لماذا لم يُقبل إنجازي؟',
    answers: Object.freeze({
      '6-8': 'ربما نقص شيء صغير. جرّب مرة أخرى اليوم.',
      '9-11': 'غالبًا لأن الدليل المطلوب لم يكتمل. راجع المهمة وأعد الإرسال.',
      '12-14': 'كل مهمة لها شرط تحقق. راجع الشرط المكتوب في المهمة ثم أعد الإرسال.',
      '15-17': 'لكل مهمة شرط تحقق محدد. راجعه في تفاصيل المهمة ثم أعد الإرسال.',
    }),
  }),
  Object.freeze({
    code: 'HOW_DO_I_MEMORISE_BETTER' as const,
    questionAr: 'كيف أحفظ بشكل أفضل؟',
    answers: Object.freeze({
      '6-8': 'اقرأ الآية ثلاث مرات، ثم قلها بلا نظر.',
      '9-11': 'قسّم الحفظ إلى أجزاء صغيرة، وكرر كل جزء ثلاث مرات قبل الانتقال.',
      '12-14': 'احفظ على أجزاء صغيرة، وراجع ما حفظته أمس قبل أن تبدأ الجديد.',
      '15-17': 'قسّم النص، كرر كل جزء بصوت مسموع، وراجع حفظ الأمس قبل الجديد — التكرار الموزّع أفضل من الجلسة الطويلة.',
    }),
  }),
  Object.freeze({
    code: 'HOW_DO_I_FOCUS_WHILE_STUDYING' as const,
    questionAr: 'كيف أركّز أثناء المذاكرة؟',
    answers: Object.freeze({
      '6-8': 'اجلس في مكان هادئ، وابدأ بعشر دقائق فقط.',
      '9-11': 'ابدأ بجلسة قصيرة في مكان هادئ، وأبعد ما يشتتك عن الطاولة.',
      '12-14': 'اعمل بجلسات قصيرة متتالية مع راحة قصيرة بينها، وأبعد الجهاز عن يدك.',
      '15-17': 'جلسات ٢٥ دقيقة براحة قصيرة بينها، والجهاز خارج مجال يدك — الترتيب يفعل أكثر من العزيمة.',
    }),
  }),
  Object.freeze({
    code: 'WHAT_IF_I_MISS_A_DAY' as const,
    questionAr: 'ماذا لو فاتني يوم؟',
    answers: Object.freeze({
      '6-8': 'لا بأس. نبدأ من جديد اليوم.',
      '9-11': 'تبدأ السلسلة من جديد، وما جمعته قبلها يبقى لك.',
      '12-14': 'تُعاد السلسلة إلى الصفر، لكن نقاطك السابقة لا تُمس. المهم أن تعود اليوم.',
      '15-17': 'السلسلة تُعاد إلى الصفر ونقاطك السابقة تبقى كما هي. العودة أهم من الاستمرار المثالي.',
    }),
  }),
]);

export function listChildTopics(): readonly ChildTopic[] {
  return TOPICS.map(({ code, questionAr }) => ({ code, questionAr }));
}

export function isChildTopicCode(value: string): value is ChildTopicCode {
  return (CHILD_TOPIC_CODES as readonly string[]).includes(value);
}

export function childTopicAnswer(code: ChildTopicCode, band: AgeBand): string {
  const entry = TOPICS.find((t) => t.code === code);
  // Unreachable while `code` is typed — kept because the controller narrows a
  // runtime string and a future code added to the union without an entry here
  // must fail loudly at its first call, not return `undefined` to a child.
  if (!entry) throw new Error(`No child topic entry for code ${code}`);
  return entry.answers[band];
}

export const CHILD_TOPIC_ENTRIES = TOPICS;
