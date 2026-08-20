import type { BusinessDate } from '../../../common/time/family-date';

/**
 * SPRINT F1 — THE VOCABULARY OF THE THREE CHILD-FACING SIGNALS, AND THE
 * ARGUMENT FOR WHY EACH ONE IS A ROW STATE RATHER THAN A GUESS.
 *
 * THE GAP THIS CLOSES, and it is `PF-E-001` for the fourth time. Four CHILD
 * copy keys had four tone bands of Arabic and English, a quiet-hours class, two
 * scoring rows and a deep-link destination, and nothing in `src/` could produce
 * them:
 *
 *   `HYDRATION_REMINDER` · `STUDY_REMINDER` · `EXERCISE_ENCOURAGEMENT`
 *       reachable only through `SmartNotificationIntegrationService.processSignals`,
 *       which has ZERO callers in `src/`.
 *   `STREAK_AT_RISK`
 *       selected by `COPY_RULES` from `c.streak`, and
 *       `NotificationContextAssembler` fills that slot from `input.streak`
 *       ALONE. No door site anywhere in `src/` passed `streak:`.
 *
 * WHY `processSignals` WAS NOT GIVEN A CALLER, stated plainly because the brief
 * asked for the judgement rather than for a call. That method is the WRONG
 * SHAPE, and not marginally:
 *
 *   1. IT BYPASSES THE DECISION LAYER. It goes candidate -> `evaluateFatigue`
 *      -> `deliverNow`. No `handleEvent`, so no `notification_decisions` row,
 *      no score, no reason, no `copy_key`, no deep link — the four things
 *      Phase F exists to add.
 *   2. ITS COPY IS THREE ENGLISH STRING LITERALS compiled into
 *      `smart-notification-decision-engine.ts` («Water break?», «Study time»,
 *      «Keep your N-day streak going!»). This product is Arabic-first and its
 *      child copy is age-banded in four tone bands; those literals are neither.
 *      Calling it would have delivered English to an Egyptian nine-year-old and
 *      reported success.
 *   3. ITS INPUT CANNOT BE ASSEMBLED. `ISmartNotificationSignals` asks for
 *      `screenMinutesLast90` and `usualStudyWindowStarted`. The first is a
 *      rolling-window figure no table in this schema holds (the device uploads
 *      a DAY total); the second is a behavioural baseline — «the child's USUAL
 *      study time» — which is the speculative inference this producer must not
 *      become.
 *
 * So the three THRESHOLDS it states are kept, because they are the product's
 * own already-shipped definition of these three moments, and the SIGNALS are
 * re-derived from columns that exist. Every number below is either a constant
 * already in production or a column a human typed.
 *
 * ---------------------------------------------------------------------------
 * THE THREE CONDITIONS. Each is a function of rows plus one instant.
 *
 *   HYDRATION            the device has reported >= `SCREEN_MINUTES_FOR_BREAK`
 *                        minutes of screen time for the family's CURRENT
 *                        business date, and `hydration_logs` summed over that
 *                        same family-local day is below
 *                        `HYDRATION_DEFICIT_RATIO` of the age-derived target
 *                        (`computeHydrationTargetMl`, unchanged).
 *   HABIT WINDOW         an ACTIVE habit whose PARENT-SET `scheduled_start_time`
 *                        window is open at the family's local clock right now,
 *                        with no `habit_completions` row for today. The window
 *                        is a column a parent typed, never a learned baseline.
 *   ACTIVITY STREAK      `activity_logs` say the child hit
 *                        `ACTIVITY_TARGET_MINUTES` on each of the N days ending
 *                        YESTERDAY, has not hit it today, and today has fewer
 *                        than `STREAK_URGENCY_HORIZON_HOURS` left on the
 *                        family's clock.
 *
 * ---------------------------------------------------------------------------
 * THE TWO GOAL KEYS ARE DELIBERATELY LEFT ON THE DEFECT LEDGER, and this is the
 * argument, because it is the part of this work most likely to be mistaken for
 * an omission.
 *
 *   `GOAL_ALMOST_DONE`   IS NOT PRODUCIBLE, and two independent things are
 *                        missing. FIRST: the copy rule is
 *                        `totalUnits - completedUnits === 1 && completedUnits > 0`,
 *                        and THERE IS NO PARTIAL-PROGRESS COLUMN FOR ANY GOAL
 *                        IN THIS SCHEMA — `achievement_requests` records
 *                        `elapsed_minutes` and only AT SUBMISSION, which is why
 *                        `stalled-goal.types.ts` had to state the same absence
 *                        for its own rejected mid-day rule. SECOND:
 *                        `COPY_CATALOGUE.GOAL_ALMOST_DONE` declares
 *                        `variables: ['done', 'total', 'unitNoun']` and three of
 *                        its four tone bands interpolate `{unitNoun}` («آيات»),
 *                        a noun with NO server-side source — no column on
 *                        `reward_programs`, no derivation, no producer, and the
 *                        renderer degrades the whole sentence to `GENERIC` when
 *                        it is absent. Counting habit completions instead and
 *                        calling them a goal's «units» would be a producer
 *                        firing on a hunch.
 *
 *   `GOAL_DEADLINE_NEAR` IS deterministically producible — an OPEN
 *                        `achievement_requests` row dated today on an ACTIVE
 *                        `reward_programs` row whose `expires_at` is inside the
 *                        rule's own thirty-minute band — and it is STILL not
 *                        produced here, on purpose. Both goal rules read the
 *                        SAME fact slot (`c.goal`), and
 *                        `notification-producer-chain.guard.spec.ts` decides
 *                        producibility by asking whether a CHILD-audience door
 *                        site passes `goal:` at all. So a producer that supplied
 *                        goal facts would make `GOAL_ALMOST_DONE` count as
 *                        producible and force its ledger entry to be deleted —
 *                        erasing a REAL, still-open defect. A ledger that can be
 *                        cleared by a key it does not describe is a scoreboard,
 *                        which is precisely what that file exists not to be. The
 *                        condition is written down in the sprint report with the
 *                        one change (`unitNoun`, in `notification-copy.ts`, a
 *                        file this work does not own) that would let both ship
 *                        together.
 *
 * ---------------------------------------------------------------------------
 * WHAT ELSE WAS DELIBERATELY NOT BUILT, and each rejection is the same
 * rejection — it would have needed a number this schema does not hold:
 *
 *   «the child is behind schedule»   an expected-progress curve. Rejected here
 *                        for the same reason `stalled-goal.types.ts` rejected
 *                        it.
 *   «the child usually studies at 5»  a behavioural baseline, i.e. the
 *                        speculative feature this file exists not to be.
 *                        `habits.scheduled_start_time` is used INSTEAD, and it
 *                        is the opposite kind of thing: a parent's own setting.
 *
 * ---------------------------------------------------------------------------
 * THE FAMILY'S CALENDAR, NOT UTC. Every window, every day boundary and every
 * dedup key below is derived from `Family.timezone` through `family-date.ts`.
 * A Cairo household and a Riyadh household evaluated at one instant ask about
 * DIFFERENT calendar days and read DIFFERENT wall clocks, which is what
 * `child-signal-producer.e2e.spec.ts` executes in both zones.
 */

/**
 * «A LONG STRETCH ON SCREEN», in minutes, and it is not a new number: it is the
 * `screenMinutesLast90 >= 90` in `smart-notification-decision-engine.ts`, i.e.
 * the threshold this product already shipped for this exact sentence. What
 * changed is the WINDOW it is measured over — a rolling ninety minutes is not
 * something any table here records, and the device uploads a running DAY total
 * (`daily_behavioral_snapshots.total_screen_minutes`). A day total crossing 90
 * is a weaker claim than ninety continuous minutes and it is the one the data
 * supports; the copy («مرّ وقت طويل على الشاشة») is true of both.
 */
export const SCREEN_MINUTES_FOR_BREAK = 90;

/**
 * «BEHIND ON WATER» — below half the day's target. The `hydrationRatio < 0.5`
 * of the same production rule, against the same `computeHydrationTargetMl`
 * target the health score, the daily progress screen and the reward trigger all
 * already use. One number, four readers.
 */
export const HYDRATION_DEFICIT_RATIO = 0.5;

/**
 * The daily activity goal, in minutes. NOT a new constant: `getDailyProgress`
 * and `computeAndStoreHealthScore` both use 60 and `logActivity` fires
 * `DAILY_GOAL_COMPLETED` at it. Named here so the streak question and the goal
 * question cannot drift apart.
 */
export const ACTIVITY_TARGET_MINUTES = 60;

/**
 * How far back the activity streak is reconstructed. The same 30 days
 * `HealthEngineService` already uses for its own streak reads, so the streak a
 * child sees on the progress screen and the streak this producer protects are
 * the same number.
 */
export const ACTIVITY_STREAK_LOOKBACK_DAYS = 30;

/**
 * A STREAK WORTH PROTECTING WITH THE STREAK SENTENCE, in days.
 *
 * `FamilyDailyRolloverJob.STREAK_BREAK_MIN_LENGTH` and
 * `streak-detection.consumer.ts`'s first milestone are both 3, with the
 * argument written next to the first: «Two days is a coincidence; three is a
 * habit the child would notice losing.» This file inherits that sentence rather
 * than restating a fourth number, and it is what separates the two copy keys:
 *
 *   >= 3 days   `STREAK_AT_RISK` — «خطوة واحدة تفصلك عن الحفاظ على سلسلتك التي
 *               بنيتها». The producer supplies `streak` facts, so the copy rule
 *               selects it and `URGENCY` scales with the hours left.
 *   1-2 days    `EXERCISE_ENCOURAGEMENT` — «حركة بسيطة تبقي سلسلتك حية». The
 *               producer supplies the day count as a plain variable and NO
 *               `streak` facts, so no rule fires and the gentler type sentence
 *               is what the child reads. Telling a six-year-old that a two-day
 *               streak is «at risk» is the pressure this product exists not to
 *               apply.
 */
export const STREAK_WORTH_PROTECTING_DAYS = 3;

/**
 * HOW LATE IN THE FAMILY'S DAY THE STREAK QUESTION MAY BE ASKED AT ALL, in
 * hours before the family's next business day begins.
 *
 * «You have not moved today» is TRUE at 07:00 and it is a reproach at 07:00,
 * because the child has had no chance yet. Twelve is not invented for this
 * file: `notification-scoring.ts`'s own urgency ramp is
 * `clamp01((12 - hoursUntilBreak) / 12)` and calls twelve hours «the longest
 * lead time on which "tonight" is still a meaningful word». Outside it the
 * URGENCY term contributes nothing above the type baseline anyway — so asking
 * earlier would produce a notification the engine itself considers un-urgent,
 * and would burn the day's dedup key at breakfast.
 */
export const STREAK_URGENCY_HORIZON_HOURS = 12;

/** The three signals, as a closed union. A fourth is a compile-time event. */
export type ChildSignalKind = 'HABIT_WINDOW' | 'ACTIVITY_STREAK' | 'HYDRATION';

/**
 * THE NOTIFICATION TYPES THIS PRODUCER MAY STATE, as a NAMED closed union
 * rather than an inline one.
 *
 * The name is load-bearing, not cosmetic:
 * `notification-producer-chain.guard.spec.ts` resolves a door site's event type
 * by reading the declared type of the property it is given and expanding it,
 * and it can only expand a union it can look up BY NAME. An inline union on the
 * interface field leaves the door UNRESOLVED, and an unresolved door is a RULE
 * P5 failure — correctly, because a guard that shrugs at what it cannot read is
 * a guard that reports whatever it happens to understand.
 */
export type ChildSignalEventType = 'HYDRATION_REMINDER' | 'STUDY_REMINDER' | 'EXERCISE_ENCOURAGEMENT';

/**
 * ONE THING TO SAY TO ONE CHILD, already resolved to the event type it will be
 * stated as and the facts that will select its sentence.
 *
 * `eventType` is a NOTIFICATION TYPE from `notification-class.ts` and never a
 * copy key: `STREAK_AT_RISK` has no class row, no urgency row and no
 * achievement baseline, because it was designed as a CONTEXTUAL SENTENCE about
 * another type — `COPY_CATALOGUE`'s own header says so. Emitting it as a type
 * would have needed three new rows in three tables the brief forbids
 * inventing.
 */
export interface ChildSignalCandidate {
  readonly kind: ChildSignalKind;
  readonly eventType: ChildSignalEventType;
  /**
   * The stable business identity of the FACT, not of the message. It becomes
   * `forEntity('signal', childId, entityId, businessDate)`, so a re-run on the
   * same family-local day recomputes the same string and the ledger refuses it.
   */
  readonly entityId: string;
  /** Plain template variables the producer knows and the context does not. */
  readonly variables?: Readonly<Record<string, string | number>>;
  /** `StreakFacts`, when the sentence is about a streak that ends tonight. */
  readonly streak?: {
    readonly days: number;
    readonly atRisk: boolean;
    readonly hoursUntilBreak: number | null;
  };
}

/** What one child's sweep did. Counts only — no ids, nothing a log aggregator
 * turns into a profile, the same rule `StalledGoalService` follows. */
export interface ChildSignalSweepReport {
  /** Conditions that held. May exceed `produced` — see `ONE_PER_SWEEP`. */
  readonly candidates: number;
  /** Decisions the engine actually recorded, i.e. new causes. */
  readonly produced: number;
  /** The ledger's unique key refused the cause: it was already decided today. */
  readonly alreadyDecided: number;
  /** The engine looked and said no — quiet hours, a cap, the floor. */
  readonly refused: number;
}

export const EMPTY_CHILD_SIGNAL_REPORT: ChildSignalSweepReport = Object.freeze({
  candidates: 0,
  produced: 0,
  alreadyDecided: 0,
  refused: 0,
});

/**
 * AT MOST ONE NEW REMINDER PER SWEEP, AND THE ORDER IS THE PRODUCT DECISION.
 *
 * A child who is behind on everything is the child least able to absorb three
 * notifications, and the brief says so: «a child who is behind must not be
 * buried in reminders». The per-business-date dedup keys already bound each
 * FACT to once a day; this bounds the BURST. The remaining conditions are not
 * discarded — they are still true on the next check-in, where they are
 * re-evaluated and told then, spaced by the type cooldowns
 * `DEFAULT_FATIGUE_POLICY` already sets for exactly these three types
 * (120 / 90 / 180 minutes).
 *
 * THE ORDER IS «WHAT BECOMES IMPOSSIBLE IF I WAIT», not «what scores highest»:
 *
 *   HABIT_WINDOW      a window a PARENT set, open right now, closing at
 *                     `scheduled_end_time`.
 *   ACTIVITY_STREAK   the day has hours left in it, by construction — see
 *                     `STREAK_URGENCY_HORIZON_HOURS`.
 *   HYDRATION         re-asked on the next device check-in, which is minutes
 *                     away whenever the child is actually on the screen the
 *                     condition is about.
 */
export const CHILD_SIGNAL_PRIORITY: readonly ChildSignalKind[] = Object.freeze([
  'HABIT_WINDOW',
  'ACTIVITY_STREAK',
  'HYDRATION',
]);

/**
 * Minutes since midnight for a `HH:MM` the schema stores as a plain string
 * (`habits.scheduled_start_time`). Returns `null` for anything that is not a
 * real 24-hour wall clock, because the column is a `String?` a client wrote and
 * a producer that guessed at «7:5» would open a window at a time nobody set.
 */
export function wallClockMinutes(hhmm: string | null | undefined): number | null {
  if (typeof hhmm !== 'string') return null;
  const m = /^([0-1]\d|2[0-3]):([0-5]\d)$/.exec(hhmm.trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * Is the family's local clock inside `[start, end)` right now?
 *
 * `end` absent means «until the day ends», which is what a habit with a start
 * time and no end time says. A window whose end is not after its start is
 * treated as having no end rather than as an empty window: `scheduled_end_time`
 * is a free string column with no CHECK constraint, and refusing to remind a
 * child because a parent typed the two boxes in the wrong order would be the
 * product punishing the child for the form's shortcoming.
 */
export function isInsideWindow(
  nowHHMM: string,
  startHHMM: string | null | undefined,
  endHHMM: string | null | undefined,
): boolean {
  const now = wallClockMinutes(nowHHMM);
  const start = wallClockMinutes(startHHMM);
  if (now === null || start === null) return false;
  if (now < start) return false;
  const end = wallClockMinutes(endHHMM);
  if (end === null || end <= start) return true;
  return now < end;
}

/** The day-keys of every day the child met the activity target, out of the
 * per-day totals the health repository already returns. Pure. */
export function activityQualifyingDays(
  dailyTotals: ReadonlyMap<string, number>,
  targetMinutes: number = ACTIVITY_TARGET_MINUTES,
): string[] {
  return [...dailyTotals.entries()].filter(([, minutes]) => minutes >= targetMinutes).map(([day]) => day);
}

/**
 * Hours from `now` until the family's next business day begins — i.e. until the
 * streak that has no qualifying day today actually breaks. Rounded to one
 * decimal because it is written verbatim into the persisted score explanation
 * and «breaks in 4.7333333h» is an explanation a human squints at.
 */
export function hoursUntilDayEnds(now: Date, nextDayStart: Date): number {
  return Math.max(0, Math.round(((nextDayStart.getTime() - now.getTime()) / 3_600_000) * 10) / 10);
}

/** The family-local day a sweep is about, carried as a type rather than a bare
 * string so a caller cannot hand this file an instant by accident. */
export type ChildSignalDay = BusinessDate;
