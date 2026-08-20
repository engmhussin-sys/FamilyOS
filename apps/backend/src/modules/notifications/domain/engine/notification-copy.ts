/**
 * PHASE F (`F6-002`) — THE LOCALISATION TABLE, AND THE ONLY PLACE A USER-FACING
 * STRING EXISTS IN THIS PIPELINE.
 *
 * WHAT WAS THERE, MEASURED. Three English sentences in
 * `smart-notification-decision-engine.ts` («Water break?», «Study time», «Keep
 * your N-day streak going!»), two Arabic sentences in
 * `notification-reward.consumer.ts`, and one Arabic sentence in
 * `digital-wellbeing-engine.service.ts`. Six strings, three files, two
 * languages, zero age adaptation, and every one of them written next to the
 * logic that decided to send it — so changing a word meant editing an engine.
 *
 * THE RULES THIS FILE ENFORCES, each of them asserted by
 * `test/notifications/notification-copy.spec.ts`:
 *
 *   1. ARABIC IS FIRST-CLASS, not a translation. `ar` is the fallback locale
 *      (CONTEXT §1), and every entry has a complete `ar` variant. An `en`
 *      variant that is missing falls back to `ar`, never the other way round.
 *   2. NO RAW ENUM EVER REACHES A HUMAN. The renderer refuses to emit a string
 *      containing an unresolved `{placeholder}` or an `ALL_CAPS_SNAKE` token,
 *      and falls back to the generic entry instead. `REWARD_GRANTED` is a
 *      database value; «مكافأة جديدة» is what a parent reads.
 *   3. A NEW CATEGORY NEEDS NO ENGINE CHANGE. Adding a key to `COPY_CATALOGUE`
 *      is the entire work of adding a notification kind: the scorer reads
 *      `notification-class.ts`, the tone comes from the band, and the copy comes
 *      from here.
 *   4. CHILD COPY IS PER TONE BAND. Four variants per child-facing key, because
 *      «أنجزت ٤ من ٥ آيات — تكمل الأخيرة؟» is the wrong sentence for a
 *      six-year-old and «أنجزت ٤ من ٥ — تكمل؟ 🎉» is the wrong sentence for a
 *      sixteen-year-old, and one of the two being wrong for half the users was
 *      the state before this file.
 *   5. PARENT COPY IS ONE REGISTER: respectful, specific, non-alarming,
 *      actionable. CONTEXT §3 principle 7 (NO PUNITIVE UX) applies to the parent
 *      surface too — nothing here says «تجاوز» or «مخالفة» at a parent.
 *
 * LENGTH. Every child template is held to the STRICTEST safety ceiling of any
 * age that maps into its tone band (`notification-tone.ts` explains the
 * overlap), and the spec asserts that against `ChildSafetyFilterService`'s own
 * numbers rather than against a copy of them.
 */

import type { NotificationLocale } from './notification-context';
import type { ToneAudience, ToneBand } from './notification-tone';

export interface CopyTemplate {
  readonly title: string;
  readonly body: string;
}

export type LocalisedTemplate = Readonly<Record<NotificationLocale, CopyTemplate>>;

/**
 * `PARENT` for the single parent register; a `ToneBand` for each child variant.
 * One union rather than two fields, so an entry cannot declare itself CHILD and
 * then supply only a parent variant.
 */
export type CopyVariantKey = 'PARENT' | ToneBand;

export interface CopyEntry {
  /** The `notification-class.ts` category, so analytics and the per-category cap
   * agree with the copy without a second mapping. */
  readonly category: string;
  readonly audience: ToneAudience;
  /** Placeholders this entry expects. Declared, so the renderer can detect a
   * producer that forgot one BEFORE a `{goalTitle}` reaches a child. */
  readonly variables: readonly string[];
  readonly variants: Readonly<Partial<Record<CopyVariantKey, LocalisedTemplate>>>;
}

/** Shorthand: an entry whose `ar` and `en` are both given. */
function t(arTitle: string, arBody: string, enTitle: string, enBody: string): LocalisedTemplate {
  return { ar: { title: arTitle, body: arBody }, en: { title: enTitle, body: enBody } };
}

/**
 * THE CATALOGUE.
 *
 * Keyed by COPY KEY, which is usually the notification type but does not have to
 * be: `GOAL_ALMOST_DONE` and `GOAL_DEADLINE_NEAR` are two different sentences
 * about the same `LEARNING_GOAL_ACHIEVED` category, and forcing them to be two
 * notification types in order to be two sentences is how a type vocabulary rots.
 */
export const COPY_CATALOGUE: Readonly<Record<string, CopyEntry>> = Object.freeze({
  // ===================================================================== CHILD

  GOAL_DEADLINE_NEAR: {
    category: 'GOAL',
    audience: 'CHILD',
    variables: ['minutes', 'goalTitle'],
    variants: {
      '5-7': t('باقي وقت قليل', 'باقي {minutes} دقائق لهدفك 🌟', 'Almost time', '{minutes} minutes left 🌟'),
      '8-10': t(
        'باقي وقت قليل',
        'باقي {minutes} دقائق لتُنهي {goalTitle} ✨',
        'Almost time',
        '{minutes} minutes left for {goalTitle} ✨',
      ),
      '11-13': t(
        'اقترب الوقت',
        'باقي لك {minutes} دقائق فقط لإكمال هدفك في {goalTitle}',
        'Time is close',
        'You have {minutes} minutes left to finish {goalTitle}',
      ),
      '14-17': t(
        'اقترب الوقت',
        'باقي لك {minutes} دقائق فقط لإكمال هدفك في {goalTitle}',
        'Time is close',
        '{minutes} minutes left to close out {goalTitle} today',
      ),
    },
  },

  GOAL_ALMOST_DONE: {
    category: 'GOAL',
    audience: 'CHILD',
    variables: ['done', 'total', 'unitNoun'],
    variants: {
      '5-7': t('كمان شوية', 'أنجزت {done} من {total} — تكمل؟ 🎉', 'Nearly there', '{done} of {total} done — finish? 🎉'),
      '8-10': t(
        'كمان شوية',
        'أنجزت {done} من {total} {unitNoun} — تكمل الأخيرة؟',
        'Nearly there',
        '{done} of {total} {unitNoun} — finish the last?',
      ),
      '11-13': t(
        'بقيت خطوة',
        'أنجزت {done} من {total} {unitNoun} — هل تكمل الأخيرة الآن؟',
        'One step left',
        'You finished {done} of {total} {unitNoun} — finish the last one now?',
      ),
      '14-17': t(
        'بقيت خطوة',
        'أنجزت {done} من {total} {unitNoun} — هل تكمل الأخيرة الآن؟',
        'One step left',
        '{done} of {total} {unitNoun} done — want to close it out now?',
      ),
    },
  },

  STREAK_AT_RISK: {
    category: 'ACHIEVEMENT',
    audience: 'CHILD',
    variables: ['days'],
    variants: {
      '5-7': t('سلسلتك', 'خطوة واحدة وتحافظ على سلسلتك 🔥', 'Your streak', 'One step keeps your streak 🔥'),
      '8-10': t('سلسلتك', 'أنت على بعد خطوة من سلسلتك 🔥', 'Your streak', 'One step away from your streak 🔥'),
      '11-13': t(
        'سلسلتك',
        'أنت على بعد خطوة من الحفاظ على سلسلتك',
        'Your streak',
        'You are one step from keeping your streak',
      ),
      '14-17': t(
        'سلسلتك',
        'خطوة واحدة تفصلك عن الحفاظ على سلسلتك التي بنيتها',
        'Your streak',
        'One step stands between you and the streak you built',
      ),
    },
  },

  STREAK_ACHIEVED: {
    category: 'ACHIEVEMENT',
    audience: 'CHILD',
    variables: ['days'],
    variants: {
      '5-7': t('أحسنت', 'سلسلتك وصلت {days} أيام 🎉', 'Nice', 'Your streak hit {days} days 🎉'),
      '8-10': t('أحسنت', 'حافظت على سلسلتك {days} أيام 🎉', 'Nice', 'You kept your streak {days} days 🎉'),
      '11-13': t(
        'إنجاز جديد',
        'حافظت على سلسلتك {days} أيام متتالية — استمر',
        'New milestone',
        'You kept your streak {days} days in a row — keep going',
      ),
      '14-17': t(
        'إنجاز جديد',
        'سلسلتك بلغت {days} أيام متتالية، وهذا لا يحدث بالصدفة',
        'New milestone',
        'Your streak is at {days} straight days — that is not luck',
      ),
    },
  },

  /**
   * PHASE F (`F6-006`, closing `PF-E-006`) — THE CHILD'S OWN REWARD SENTENCE,
   * AND THE REASON IT IS A NEW KEY RATHER THAN A SECOND VARIANT.
   *
   * The Golden E2E suite measured the child half of the notification surface as
   * SILENT: a child completed a task, was paid, and `child_messages` stayed at
   * zero rows, because the only `REWARD_GRANTED` subscriber targeted the parent
   * and there was no `targetAudience: 'CHILD'` producer anywhere on the reward
   * path. That is the commercial wedge failing — CONTEXT §1's «تطبيق الطفل هو
   * منتج قائم بذاته يريد الطفل فتحه» with no feedback loop in it.
   *
   * `REWARD_GRANTED`'s entry is `audience: 'PARENT'`, and `audience` is a
   * property of the ENTRY here — one key cannot be both. Splitting the key is
   * also what lets the two sides be scored, capped and suppressed
   * INDEPENDENTLY, which they should be: a parent at their daily cap should not
   * silence the child's own «حصلت على مكافأة».
   *
   * NO VARIABLES, deliberately. The `REWARD_GRANTED` domain event carries a
   * grant COUNT and a resulting balance, and neither belongs in a sentence to a
   * seven-year-old: «حصلت على ٣ مكافآت» is a receipt, not encouragement, and
   * the balance is a number the child's own app already shows. The sentence
   * points at the app; the app holds the detail (docs/06 §8.3).
   */
  REWARD_GRANTED_CHILD: {
    category: 'REWARD',
    audience: 'CHILD',
    variables: [],
    variants: {
      '5-7': t('مكافأة جديدة', 'حصلت على مكافأة جديدة 🎉', 'New reward', 'You earned a new reward 🎉'),
      '8-10': t(
        'مكافأة جديدة',
        'حصلت على مكافأة جديدة اليوم 🎉',
        'New reward',
        'You earned a new reward today 🎉',
      ),
      '11-13': t(
        'مكافأة جديدة',
        'حصلت على مكافأة جديدة اليوم — افتح التطبيق لتراها',
        'New reward',
        'You earned a new reward — see it in the app',
      ),
      '14-17': t(
        'مكافأة جديدة',
        'حصلت على مكافأة جديدة اليوم، وهي محفوظة في سجلك',
        'New reward',
        'You earned a new reward today, and it is saved to your record',
      ),
    },
  },

  BADGE_EARNED: {
    category: 'ACHIEVEMENT',
    audience: 'CHILD',
    variables: ['badgeTitle'],
    variants: {
      '5-7': t('وسام جديد', 'كسبت وسام {badgeTitle} 🏅', 'New badge', 'You earned {badgeTitle} 🏅'),
      '8-10': t('وسام جديد', 'كسبت وسام {badgeTitle} اليوم 🏅', 'New badge', 'You earned the {badgeTitle} badge 🏅'),
      '11-13': t(
        'وسام جديد',
        'حصلت على وسام {badgeTitle} — يستحق أن تراه',
        'New badge',
        'You earned the {badgeTitle} badge — worth a look',
      ),
      '14-17': t(
        'وسام جديد',
        'حصلت على وسام {badgeTitle}، وهو محفوظ في سجلك',
        'New badge',
        'You earned {badgeTitle}, and it is saved to your record',
      ),
    },
  },

  LEVEL_UP: {
    category: 'ACHIEVEMENT',
    audience: 'CHILD',
    variables: ['level'],
    variants: {
      '5-7': t('مستوى جديد', 'وصلت للمستوى {level} 🚀', 'Level up', 'You reached level {level} 🚀'),
      '8-10': t('مستوى جديد', 'وصلت إلى المستوى {level} 🚀', 'Level up', 'You reached level {level} 🚀'),
      '11-13': t(
        'مستوى جديد',
        'وصلت إلى المستوى {level} — تقدّم واضح',
        'Level up',
        'You reached level {level} — clear progress',
      ),
      '14-17': t(
        'مستوى جديد',
        'وصلت إلى المستوى {level}، وهذه نتيجة أسابيع من العمل',
        'Level up',
        'Level {level} reached — that is weeks of work',
      ),
    },
  },

  DAILY_GOAL_COMPLETED: {
    category: 'GOAL',
    audience: 'CHILD',
    variables: ['goalTitle'],
    variants: {
      '5-7': t('أنهيت هدفك', 'أنهيت {goalTitle} اليوم 🌟', 'Goal done', 'You finished {goalTitle} 🌟'),
      '8-10': t('أنهيت هدفك', 'أنهيت هدف {goalTitle} اليوم 🌟', 'Goal done', 'You finished {goalTitle} today 🌟'),
      '11-13': t(
        'أنهيت هدفك',
        'أكملت هدف {goalTitle} اليوم كما خططت',
        'Goal done',
        'You completed {goalTitle} today as planned',
      ),
      '14-17': t(
        'أنهيت هدفك',
        'أكملت هدف {goalTitle} اليوم كما خططت له',
        'Goal done',
        'You completed {goalTitle} today, as planned',
      ),
    },
  },

  LEARNING_GOAL_ACHIEVED: {
    category: 'GOAL',
    audience: 'CHILD',
    variables: ['goalTitle'],
    variants: {
      '5-7': t('أحسنت', 'أنهيت {goalTitle} كله 🎉', 'Well done', 'You finished all of {goalTitle} 🎉'),
      '8-10': t('أحسنت', 'أنهيت هدف {goalTitle} بالكامل 🎉', 'Well done', 'You finished all of {goalTitle} 🎉'),
      '11-13': t(
        'هدف مكتمل',
        'أنهيت هدف {goalTitle} بالكامل — إنجاز حقيقي',
        'Goal complete',
        'You finished {goalTitle} end to end — real progress',
      ),
      '14-17': t(
        'هدف مكتمل',
        'أنهيت هدف {goalTitle} بالكامل، وهذا يفتح الهدف التالي',
        'Goal complete',
        'You finished {goalTitle} — the next goal is open',
      ),
    },
  },

  ACHIEVEMENT_VERIFIED: {
    category: 'ACHIEVEMENT',
    audience: 'CHILD',
    variables: ['goalTitle'],
    variants: {
      '5-7': t('تم التأكيد', 'أهلك أكدوا {goalTitle} ✅', 'Confirmed', 'Your family confirmed {goalTitle} ✅'),
      '8-10': t('تم التأكيد', 'أهلك أكدوا إنجازك في {goalTitle} ✅', 'Confirmed', 'Your family confirmed {goalTitle} ✅'),
      '11-13': t(
        'تم التأكيد',
        'تم تأكيد إنجازك في {goalTitle} من أهلك',
        'Confirmed',
        'Your achievement in {goalTitle} was confirmed',
      ),
      '14-17': t(
        'تم التأكيد',
        'تم تأكيد إنجازك في {goalTitle}، وأُضيف إلى سجلك',
        'Confirmed',
        'Your {goalTitle} achievement was confirmed and recorded',
      ),
    },
  },

  ACHIEVEMENT_REJECTED: {
    category: 'ACHIEVEMENT',
    audience: 'CHILD',
    variables: ['goalTitle'],
    variants: {
      '5-7': t('نحتاج مراجعة', 'راجع {goalTitle} مع أهلك', 'Let us check', 'Check {goalTitle} with your family'),
      '8-10': t(
        'نحتاج مراجعة',
        'راجع هدف {goalTitle} مع أهلك اليوم',
        'Let us check',
        'Review {goalTitle} with your family today',
      ),
      '11-13': t(
        'نحتاج مراجعة',
        'يحتاج {goalTitle} مراجعة بسيطة مع أهلك',
        'Needs a look',
        '{goalTitle} needs a quick review with your family',
      ),
      '14-17': t(
        'نحتاج مراجعة',
        'يحتاج {goalTitle} مراجعة مع أهلك قبل اعتماده',
        'Needs a look',
        '{goalTitle} needs a review with your family before it counts',
      ),
    },
  },

  HYDRATION_REMINDER: {
    category: 'REMINDER',
    audience: 'CHILD',
    variables: [],
    variants: {
      '5-7': t('وقت الماء', 'خذ رشفة ماء الآن 💧', 'Water time', 'Take a sip of water 💧'),
      '8-10': t('وقت الماء', 'خذ استراحة قصيرة واشرب ماء 💧', 'Water time', 'Take a short break and drink 💧'),
      '11-13': t('وقت الماء', 'مرّ وقت طويل — استراحة قصيرة وكوب ماء', 'Water time', 'It has been a while — a short break and water'),
      '14-17': t(
        'وقت الماء',
        'مرّ وقت طويل على الشاشة — استراحة قصيرة وكوب ماء',
        'Water time',
        'Long stretch on screen — take a break and some water',
      ),
    },
  },

  STUDY_REMINDER: {
    category: 'REMINDER',
    audience: 'CHILD',
    variables: ['goalTitle'],
    variants: {
      '5-7': t('وقت المذاكرة', 'وقت {goalTitle} بدأ 📘', 'Study time', '{goalTitle} time 📘'),
      '8-10': t('وقت المذاكرة', 'بدأ وقتك المعتاد لـ {goalTitle} 📘', 'Study time', 'Your usual {goalTitle} time started 📘'),
      '11-13': t(
        'وقت المذاكرة',
        'بدأ وقتك المعتاد لـ {goalTitle} — جاهز تبدأ؟',
        'Study time',
        'Your usual {goalTitle} time started — ready?',
      ),
      '14-17': t(
        'وقت المذاكرة',
        'بدأ وقتك المعتاد لـ {goalTitle} — عشرون دقيقة تكفي للبداية',
        'Study time',
        'Your usual {goalTitle} window started — twenty minutes is enough to start',
      ),
    },
  },

  EXERCISE_ENCOURAGEMENT: {
    category: 'REMINDER',
    audience: 'CHILD',
    variables: ['days'],
    variants: {
      '5-7': t('حركة صغيرة', 'حركة صغيرة تكفي اليوم ⚡', 'Move a bit', 'A little movement is enough ⚡'),
      '8-10': t('حركة صغيرة', 'حركة بسيطة تبقي سلسلتك حية ⚡', 'Move a bit', 'A little movement keeps your streak ⚡'),
      '11-13': t(
        'حركة صغيرة',
        'لم تسجل نشاطًا اليوم — حركة بسيطة تكفي',
        'Move a bit',
        'No activity logged today — a little is enough',
      ),
      '14-17': t(
        'حركة صغيرة',
        'لم تسجّل نشاطًا اليوم، وحركة قصيرة تكفي للحفاظ على {days} أيام',
        'Move a bit',
        'Nothing logged today — a short session protects {days} days',
      ),
    },
  },

  // ==================================================================== PARENT

  GOAL_COMPLETED_PARENT: {
    category: 'GOAL',
    audience: 'PARENT',
    variables: ['childName', 'goalTitle', 'weekCount'],
    variants: {
      PARENT: t(
        'هدف مكتمل',
        '{childName} أكمل هدفه في {goalTitle}، وهذه {weekCount} مرة هذا الأسبوع',
        'Goal completed',
        '{childName} completed the {goalTitle} goal — time number {weekCount} this week',
      ),
    },
  },

  GOAL_STALLED_PARENT: {
    category: 'GOAL',
    audience: 'PARENT',
    variables: ['childName', 'goalTitle'],
    variants: {
      PARENT: t(
        'هدف بدأ ولم يكتمل',
        'بدأ {childName} هدف {goalTitle} ولم يكمله — ربما يحتاج دفعة اليوم',
        'Goal started, not finished',
        '{childName} started {goalTitle} and did not finish — a nudge today may help',
      ),
    },
  },

  /**
   * ==========================================================================
   * THE PARENT'S REWARD SENTENCE WHEN THE CAUSE IS A GOAL THE PARENT SET.
   * ==========================================================================
   *
   * WHAT WAS MEASURED, and `e2e-13 STEP 14` pinned it to the byte: a household
   * whose whole chain started at «حفظ سورة الملك، الآيات ١–٥» was told «حصل محمد
   * على مكافأة جديدة اليوم. افتح التطبيق لرؤية التفاصيل.» and `notifications.data`
   * was NULL — so the goal was unreachable from the notification by ANY field.
   * The parent learned THAT something happened and had to open the app to learn
   * WHAT, which is a broadcast with a pointer attached, not a coach.
   *
   * --------------------------------------------------------------------------
   * WHY A SIBLING KEY RATHER THAN `GOAL_COMPLETED_PARENT`, WHICH ALREADY TAKES
   * A `goalTitle`. Four reasons, and the first one is decisive on its own:
   *
   *   1. IT WOULD MAKE THE PRODUCT INVENT A FACT. `GOAL_COMPLETED_PARENT`
   *      declares `weekCount` and its sentence ends «…وهذه ثالث مرة هذا
   *      الأسبوع». The reward path has no week count — `REWARD_GRANTED` is
   *      emitted by `RewardsCompletionConsumer` from a ledger grant, which knows
   *      nothing about how many times this happened this week. Supplying a
   *      number would publish an invented fact; omitting it makes the renderer
   *      treat the template as leaking and fall through to `GENERIC`, which is
   *      «لديك تحديث جديد داخل التطبيق» — strictly worse than what is there now.
   *   2. THE SENTENCE HAS TO CARRY THE POINTS, and points are a REWARD fact.
   *      `GOAL_COMPLETED_PARENT` has nowhere to put «وحصل على ٢٠ نقطة» without
   *      being rewritten into a reward sentence — at which point it is this
   *      entry with an older name and one extra caller to keep in step.
   *   3. ONE CAUSE, ONE TEMPLATE. `GOAL_COMPLETED_PARENT` is the sentence for a
   *      goal COMPLETION (`e2e-05 ACT II` pins it), and a completion and a paid
   *      reward are two different causes that can occur without each other — a
   *      completion no Reward Rule matched pays nothing and must still be
   *      announceable. Overloading one template would make «which event am I
   *      reading about?» unanswerable from the row.
   *   4. THE TYPE VOCABULARY STAYS TRUE. `notifications.type` remains
   *      `REWARD_GRANTED`, which is what `notification-scoring.ts` weights,
   *      what `notification-class.ts` classifies for quiet hours, and what the
   *      analytics count. Only the COPY KEY differs — and this catalogue's
   *      header already states that a key need not be a type, because
   *      `GOAL_ALMOST_DONE` and `GOAL_DEADLINE_NEAR` are two sentences about one
   *      category.
   *
   * WHICH OF THE TWO REWARD ENTRIES IS USED is decided by
   * `RuleBasedNotificationDecisionProvider`'s `COPY_RULES` — the existing,
   * data-driven seam that already picks a better child sentence when the context
   * carries a goal — and it requires BOTH variables to be present and non-empty.
   * A producer that has only one of them gets `REWARD_GRANTED` below, which is a
   * complete sentence rather than a half-filled one.
   *
   * `goalTitle` IS `RewardProgram.targetSummaryAr` — «الآيات 1–5 من سورة الملك» —
   * derived ONCE by `describeTargetSpec` at program creation. Nothing in this
   * layer assembles Arabic out of a surah number and two ayah indices, and
   * nothing in it should: three clients read that same derived string.
   *
   * IT ANSWERS THE THREE QUESTIONS A PARENT NOTIFICATION OWES:
   *   WHY am I being told   — «أكمل … اليوم»: their child finished the goal
   *                            they themselves set.
   *   WHAT happened          — the goal, by name, and the points, from the ledger.
   *   WHAT DO I DO           — «افتح التطبيق لتشجيعه»: an action, not a dead end.
   */
  REWARD_GRANTED_WITH_GOAL: {
    category: 'REWARD',
    audience: 'PARENT',
    variables: ['childName', 'goalTitle', 'points'],
    variants: {
      PARENT: t(
        'مكافأة جديدة',
        '🌟 {childName} أكمل {goalTitle} اليوم وحصل على {points} نقطة. افتح التطبيق لتشجيعه.',
        'New reward',
        '🌟 {childName} completed {goalTitle} today and earned {points} points. Open the app to cheer them on.',
      ),
    },
  },

  /**
   * The reward sentence for every cause that is NOT a parent-authored goal — a
   * habit tick, a hydration target, a streak milestone — and the honest fallback
   * whenever the goal facts are missing. It names the child and it does not
   * pretend to know what was achieved, because on those paths nothing does.
   */
  REWARD_GRANTED: {
    category: 'REWARD',
    audience: 'PARENT',
    variables: ['childName'],
    variants: {
      PARENT: t(
        'مكافأة جديدة',
        'حصل {childName} على مكافأة جديدة اليوم. افتح التطبيق لرؤية التفاصيل.',
        'New reward',
        '{childName} earned a new reward today. Open the app for details.',
      ),
    },
  },

  /**
   * PHASE F (`F6-003`) — the parent's half of a badge.
   *
   * A SEPARATE KEY rather than a second variant under `BADGE_EARNED`, because
   * `audience` is a property of the ENTRY in this catalogue and the child's
   * badge sentence and the parent's are two different messages about one fact.
   * `rewards-engine.service.ts` notified BOTH audiences long before this phase
   * — in English, from two string literals — and this key is where the parent
   * half now comes from.
   */
  BADGE_EARNED_PARENT: {
    category: 'ACHIEVEMENT',
    audience: 'PARENT',
    variables: ['childName', 'badgeTitle'],
    variants: {
      PARENT: t(
        'وسام جديد',
        'حصل {childName} على وسام {badgeTitle}. التفاصيل داخل التطبيق.',
        'New badge',
        '{childName} earned the {badgeTitle} badge. Details are in the app.',
      ),
    },
  },

  SCREEN_TIME_EXCEEDED: {
    category: 'SAFETY',
    audience: 'PARENT',
    variables: ['childName'],
    variants: {
      PARENT: t(
        'انتهى وقت الشاشة',
        'انتهى وقت الشاشة المخصص لـ {childName} اليوم. التفاصيل داخل التطبيق.',
        'Screen time ended',
        "{childName}'s screen time for today has ended. Details are in the app.",
      ),
    },
  },

  POLICY_VIOLATION: {
    category: 'SAFETY',
    audience: 'PARENT',
    variables: ['childName'],
    variants: {
      PARENT: t(
        'تحديث على الإعدادات',
        'هناك ما يستحق مراجعتك في إعدادات {childName}. افتح التطبيق للاطلاع.',
        'Worth a look',
        "Something in {childName}'s settings is worth your review. Open the app.",
      ),
    },
  },

  ACCESSIBILITY_DISABLED: {
    category: 'SAFETY',
    audience: 'PARENT',
    variables: ['childName'],
    variants: {
      PARENT: t(
        'الحماية متوقفة',
        'خدمة الحماية على جهاز {childName} متوقفة الآن. تفعيلها يستغرق دقيقة.',
        'Protection is off',
        "Protection on {childName}'s device is off right now. Turning it on takes a minute.",
      ),
    },
  },

  PROTECTION_BYPASS_ATTEMPT: {
    category: 'SAFETY',
    audience: 'PARENT',
    variables: ['childName'],
    variants: {
      PARENT: t(
        'محاولة تعطيل الحماية',
        'سُجّلت محاولة لتعطيل الحماية على جهاز {childName}. راجع الإعدادات.',
        'Protection change attempt',
        "An attempt to turn off protection on {childName}'s device was recorded. Review settings.",
      ),
    },
  },

  CHILD_WELLBEING_CHECKIN: {
    category: 'SAFETY',
    audience: 'PARENT',
    variables: ['childName'],
    variants: {
      PARENT: t(
        'اطمئن على {childName}',
        'ظهرت إشارات تستحق اطمئنانك على {childName} الآن.',
        'Check in on {childName}',
        'Signals worth a check-in with {childName} right now.',
      ),
    },
  },

  CHILD_REQUEST: {
    category: 'SAFETY',
    audience: 'PARENT',
    variables: ['childName'],
    variants: {
      PARENT: t(
        'طلب من {childName}',
        'أرسل {childName} طلبًا ينتظر ردّك داخل التطبيق.',
        'Request from {childName}',
        '{childName} sent a request waiting for your answer in the app.',
      ),
    },
  },

  SUBSCRIPTION_EXPIRING: {
    category: 'SUBSCRIPTION',
    audience: 'PARENT',
    variables: ['days'],
    variants: {
      PARENT: t(
        'اشتراكك يقترب من التجديد',
        'يتبقى {days} يومًا على تجديد اشتراكك. يمكنك المراجعة داخل التطبيق.',
        'Renewal is near',
        'Your subscription renews in {days} days. You can review it in the app.',
      ),
    },
  },

  PAYMENT_FAILED: {
    category: 'PAYMENT',
    audience: 'PARENT',
    variables: [],
    variants: {
      PARENT: t(
        'تعذّر إتمام الدفع',
        'لم تكتمل عملية الدفع الأخيرة. يمكنك المحاولة مرة أخرى من داخل التطبيق.',
        'Payment did not go through',
        'The last payment did not complete. You can try again from the app.',
      ),
    },
  },

  /**
   * PHASE F (`F6-003`) — the generic runtime alert, which had no sentence here
   * because its two producers (`RuntimeAlertService`,
   * `DistressEscalationService`) write to `IRuntimeAlertRepository` DIRECTLY
   * and never reach the composer. They are the two paths this phase did not
   * wire — see the Wiring Report's open risks — and the entry exists so that
   * the day they are routed, the parent reads a sentence rather than `GENERIC`.
   */
  RUNTIME_ALERT: {
    category: 'SYSTEM',
    audience: 'PARENT',
    variables: [],
    variants: {
      PARENT: t(
        'تنبيه من الجهاز',
        'هناك تنبيه جديد من جهاز طفلك. افتح التطبيق للاطلاع عليه.',
        'Device alert',
        "There is a new alert from your child's device. Open the app to review it.",
      ),
    },
  },

  QUIET_HOURS_DIGEST: {
    category: 'SYSTEM',
    audience: 'PARENT',
    variables: ['count'],
    variants: {
      PARENT: t(
        'ملخّص الليلة',
        'لديك {count} تحديثات من الليلة الماضية. افتح التطبيق للاطلاع عليها.',
        'Overnight summary',
        'You have {count} updates from last night. Open the app to review them.',
      ),
    },
  },

  /**
   * THE FALLBACK, and it is deliberately CONTENTLESS.
   *
   * It is reached when a producer sends a type nobody has written copy for. The
   * alternative — echoing `candidate.type` into the body — is precisely the
   * «render a raw backend enum to a user» failure this file exists to make
   * impossible, and it is what `parent-app`'s home screen was doing with a risk
   * enum before Phase E fixed it. A vague-but-human sentence plus a pointer into
   * the app is the honest degraded state.
   */
  GENERIC: {
    category: 'SYSTEM',
    audience: 'PARENT',
    variables: [],
    variants: {
      PARENT: t(
        'تحديث جديد',
        'لديك تحديث جديد داخل التطبيق.',
        'New update',
        'You have a new update in the app.',
      ),
      '5-7': t('تحديث جديد', 'لديك جديد في التطبيق ✨', 'Something new', 'Something new in the app ✨'),
      '8-10': t('تحديث جديد', 'لديك جديد في التطبيق ✨', 'Something new', 'Something new in the app ✨'),
      '11-13': t('تحديث جديد', 'لديك تحديث جديد في التطبيق', 'Something new', 'You have a new update in the app'),
      '14-17': t('تحديث جديد', 'لديك تحديث جديد في التطبيق', 'Something new', 'You have a new update in the app'),
    },
  },
});

export const GENERIC_COPY_KEY = 'GENERIC';

/**
 * ============================================================================
 * WHO IS THIS NOTIFICATION ADDRESSED TO — ONE ANSWER, FOR EVERY ASKER.
 * ============================================================================
 *
 * `RuleBasedNotificationDecisionProvider.audienceFor` was the only place this
 * question was answered, which was fine for exactly as long as the provider was
 * the only thing that needed the answer. It is not: `NotificationContextAssembler`
 * has to know the audience BEFORE the provider runs, because the audience
 * decides WHICH INBOX the fatigue history is read from — and an assembler that
 * re-derived the rule beside the provider would be two rules that agree until
 * one of them is edited.
 *
 * THE RULE, unchanged from the provider's own: the catalogue entry states it;
 * a type with no entry belongs to the child when there is a child in the
 * context and to the parent otherwise. A `BOTH` type in
 * `notification-class.ts` is not resolved here at all — `BOTH` means the
 * PRODUCER composes two candidates with two `sourceEventId` facets, and each
 * one arrives at this function carrying its own single-audience type
 * (`REWARD_GRANTED` / `REWARD_GRANTED_CHILD`, `BADGE_EARNED_PARENT` /
 * `BADGE_EARNED`). That is why the catalogue and not the class matrix is the
 * source read here.
 */
export function resolveTargetAudience(eventType: string, hasChild: boolean): ToneAudience {
  const declared = COPY_CATALOGUE[eventType]?.audience;
  if (declared) return declared;
  return hasChild ? 'CHILD' : 'PARENT';
}

/** Arabic-Indic digits. The samples in the brief are written «٥ دقائق», not «5
 * دقائق», and a product that writes Arabic prose with Latin numerals reads as a
 * translation — which CONTEXT §1 explicitly rejects. */
const ARABIC_INDIC = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];

export function formatNumber(value: number | string, locale: NotificationLocale): string {
  const text = String(value);
  if (locale !== 'ar') return text;
  return text.replace(/[0-9]/g, (d) => ARABIC_INDIC[Number(d)]);
}

/**
 * Arabic ordinals for the «وهذه ثالث مرة هذا الأسبوع» sentence. Data, not a
 * formatter: Arabic ordinals below ten are irregular and a numeric fallback
 * («المرة ٤») is correct rather than wrong for the rest.
 */
const AR_ORDINALS = ['', 'أول', 'ثاني', 'ثالث', 'رابع', 'خامس', 'سادس', 'سابع', 'ثامن', 'تاسع'];

export function ordinal(n: number, locale: NotificationLocale): string {
  if (locale === 'ar') {
    return n >= 1 && n < AR_ORDINALS.length ? AR_ORDINALS[n] : `المرة ${formatNumber(n, 'ar')}`;
  }
  const suffix = n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th';
  return `${n}${suffix}`;
}

export interface RenderCopyRequest {
  readonly key: string;
  readonly audience: ToneAudience;
  readonly toneBand: ToneBand;
  readonly locale: NotificationLocale;
  readonly variables: Readonly<Record<string, string | number>>;
}

export interface RenderedCopy {
  readonly title: string;
  readonly body: string;
  /** Which catalogue key actually produced the text — `GENERIC` when the
   * requested key had no entry. Persisted on the decision so «why did this read
   * like a stub» has an answer. */
  readonly resolvedKey: string;
  /** Which variant was used, after the nearest-band walk. */
  readonly resolvedVariant: CopyVariantKey;
  readonly locale: NotificationLocale;
}

/**
 * The nearest-band walk. A child-facing entry that defines only some bands still
 * resolves, and it resolves DOWNWARD first — towards simpler language — because
 * a sentence that is too simple for a fourteen-year-old is a smaller failure
 * than one that is too complex for a six-year-old.
 */
const BAND_FALLBACK: Readonly<Record<ToneBand, readonly ToneBand[]>> = Object.freeze({
  '5-7': ['5-7', '8-10', '11-13', '14-17'],
  '8-10': ['8-10', '5-7', '11-13', '14-17'],
  '11-13': ['11-13', '8-10', '14-17', '5-7'],
  '14-17': ['14-17', '11-13', '8-10', '5-7'],
});

/** An unresolved placeholder, or a bare backend enum token that leaked into
 * copy. Either one means the string must not ship. */
const LEAK_PATTERN = /\{[a-zA-Z0-9_]+\}|(?:^|[\s(])[A-Z][A-Z0-9]*_[A-Z0-9_]+/;

export function hasEnumOrPlaceholderLeak(text: string): boolean {
  return LEAK_PATTERN.test(text);
}

/**
 * `F1-002` — WHY A SUBSTITUTED **STRING** ALSO NEEDS ITS DIGITS TRANSLATED, ON
 * BOTH SURFACES.
 *
 * `formatNumber` has always been applied to NUMERIC variables, so «٢٠ نقطة»
 * comes out in Arabic-Indic. It was never applied to STRING variables, and the
 * one string this product substitutes into Arabic prose is
 * `RewardProgram.targetSummaryAr` — «الآيات 1–5 من سورة الملك», written by
 * `describeTargetSpec` with LATIN numerals. So a sentence carrying both read
 * «… أكمل الآيات 1–5 من سورة الملك اليوم وحصل على ٢٠ نقطة»: two numeral systems
 * in one line, which is exactly the «reads as a translation» failure `PF-E-002`
 * names and rule 1 of this file forbids.
 *
 * THE CHILD SURFACE IS WHERE THAT RULE IS ACTUALLY PINNED — `e2e-06`, `e2e-10`
 * and `e2e-13` each assert that a child's body matches NO Latin digit — so any
 * child sentence that names a goal («أنهيت {goalTitle}»، «تم تأكيد إنجازك في
 * {goalTitle}»، «يحتاج {goalTitle} مراجعة») was unshippable while every
 * substituted string went through verbatim, WHATEVER its producer did. That is
 * the defect `F1-002` closed first, and closing it is what makes those keys
 * producible at all.
 *
 * AND `F1-003` CLOSES THE GAP THE PARAGRAPH ABOVE USED TO RECORD. This function
 * took a `localiseStringDigits` flag that was `audience !== 'PARENT'`, so the
 * parent read «🌟 محمد أكمل الآيات 1–5 من سورة الملك اليوم وحصل على ٢٠ نقطة» —
 * ONE SENTENCE IN TWO NUMERAL SYSTEMS, the exact thing the paragraph above
 * calls the failure `PF-E-002` names. The flag was scoping, and it said so:
 * «a scoping decision rather than a claim that Latin numerals are fine there».
 *
 * THE ARGUMENT FOR CLOSING IT RATHER THAN KEEPING THE SPLIT. `PF-E-002` is
 * about the READER OF ARABIC, not about the reader's age: this product is
 * Arabic-first for Egypt and Saudi Arabia, and «١–٥» is how an adult there
 * writes those numbers in prose. There is also no coherent alternative — the
 * NUMERIC half of the same sentence («٢٠ نقطة») has been Arabic-Indic since
 * `formatNumber` existed, so «Latin for parents» would mean un-localising a
 * digit the catalogue already localises, on a surface where nobody asked for
 * it. One script per sentence is the only defensible answer, and Arabic-Indic
 * is the one already chosen.
 *
 * The three parent sentences byte-pinned in `e2e-05`, `e2e-13 STEP 14` and
 * `e2e-14` are updated in place, each quoting the string it replaced, so the
 * change is legible as a deliberate act rather than a test that moved.
 *
 * WHAT IT DOES NOT TOUCH. `notifications.data.goalTitle` still carries
 * `targetSummaryAr` verbatim — a machine field is not prose — and
 * `reward_programs.target_summary_ar` itself is unchanged, so the stored value
 * and every non-prose consumer of it are exactly as they were. This is a
 * RENDERING decision, applied where prose is rendered.
 *
 * `en` IS UNTOUCHED — `formatNumber` returns its input unchanged for every
 * locale but `ar` — so an English household still reads «Al-Mulk 1–5».
 */
function substitute(
  template: string,
  variables: Readonly<Record<string, string | number>>,
  locale: NotificationLocale,
): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (whole, name: string) => {
    const value = variables[name];
    if (value === undefined || value === null || value === '') return whole;
    if (typeof value === 'number') return formatNumber(value, locale);
    return formatNumber(String(value), locale);
  });
}

/**
 * RENDER, AND NEVER RETURN SOMETHING A HUMAN SHOULD NOT READ.
 *
 * The function is total. Every failure mode — unknown key, missing band, missing
 * locale, a producer that forgot a variable — degrades to the generic entry in
 * the requested locale rather than throwing or emitting a half-substituted
 * string. A notification pipeline that throws on a copy problem turns a wording
 * bug into a lost reward.
 */
export function renderNotificationCopy(request: RenderCopyRequest): RenderedCopy {
  const attempt = (key: string): RenderedCopy | null => {
    const entry = COPY_CATALOGUE[key];
    if (!entry) return null;

    const order: readonly CopyVariantKey[] =
      request.audience === 'PARENT' ? ['PARENT'] : BAND_FALLBACK[request.toneBand];
    for (const variantKey of order) {
      const localised = entry.variants[variantKey];
      if (!localised) continue;
      // Arabic is the fallback, never English — CONTEXT §1.
      const template = localised[request.locale] ?? localised.ar;
      const title = substitute(template.title, request.variables, request.locale);
      const body = substitute(template.body, request.variables, request.locale);
      if (hasEnumOrPlaceholderLeak(title) || hasEnumOrPlaceholderLeak(body)) return null;
      return {
        title,
        body,
        resolvedKey: key,
        resolvedVariant: variantKey,
        locale: request.locale,
      };
    }
    return null;
  };

  const rendered = attempt(request.key);
  if (rendered) return rendered;

  const generic = attempt(GENERIC_COPY_KEY);
  /* istanbul ignore next — `GENERIC` has a variant for every audience and band,
     asserted by `notification-copy.spec.ts`; this branch exists so the function
     is total in the type system as well as in fact. */
  if (!generic) {
    return {
      title: request.locale === 'en' ? 'New update' : 'تحديث جديد',
      body: request.locale === 'en' ? 'You have a new update in the app.' : 'لديك تحديث جديد داخل التطبيق.',
      resolvedKey: GENERIC_COPY_KEY,
      resolvedVariant: request.audience === 'PARENT' ? 'PARENT' : request.toneBand,
      locale: request.locale,
    };
  }
  return generic;
}

/** Every key in the catalogue, for the exhaustiveness spec and the report. */
export function copyKeys(): readonly string[] {
  return Object.keys(COPY_CATALOGUE);
}
