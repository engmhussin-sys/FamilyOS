import type { BusinessDate } from '../../../common/time/family-date';
import type { GoalUnitKind } from '../../notifications/domain/engine/notification-nouns';

/**
 * ============================================================================
 * SPRINT F1 — THE TWO CHILD-FACING GOAL SENTENCES, AND THE ARGUMENT FOR WHY
 * NEITHER OF THEM NEEDED A NEW COLUMN.
 * ============================================================================
 *
 * `GOAL_DEADLINE_NEAR` and `GOAL_ALMOST_DONE` were the last two CHILD entries on
 * `PRODUCERLESS_DEFECT_LEDGER`, and they were parked for two different reasons.
 * One was a ledger-shape problem and one was «missing data». The first was true.
 * The second was not, and this file is the evidence.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE LEDGER CLAIMED WAS MISSING, AND WHAT WAS ACTUALLY THERE.
 *
 * «there is no partial-progress column for any goal — `achievement_requests`
 * records stages, never `completed_units`». TRUE AS WRITTEN, and it is the
 * wrong question. Three candidate sources were examined before anything was
 * built, and the two obvious ones really are dead:
 *
 *   ELAPSED TIME ON AN OPEN `DURATION` ATTEMPT — «`started_at` is set and the
 *   program has `duration_minutes`, so progress is derivable». REJECTED, and
 *   not on taste: `VERIFICATION_MATRIX.DURATION` says in its own Arabic that the
 *   method «يعتمد على زمن الواجهة الأمامية (foreground) لا على ساعة الحائط», and
 *   `checkDuration` REFUSES a `foregroundMinutes` larger than the wall-clock
 *   span. So wall-clock elapsed is not this product's definition of progress on
 *   a DURATION goal — it is the CEILING on progress. A child who started the
 *   timer and put the phone down has twenty-five wall-clock minutes and zero
 *   minutes of progress, and «أنجزت ٢٥ من ٣٠» to that child is a false sentence
 *   the server would then refuse at submission.
 *
 *   ANSWERED-VS-TOTAL ON A `QUIZ` — «the server serves the questions, so it
 *   knows how far in the child is». REJECTED because it does not: the server
 *   writes `quiz_assignments.total_count` when it SERVES the set and
 *   `correct_count` when it GRADES one, and the answer sheet arrives whole, in
 *   one request, at submission. There is no row anywhere that says «four of five
 *   answered», and there is no endpoint that could write one.
 *
 *   `foreground_minutes` / `elapsed_minutes` — reported and stored AT SUBMIT.
 *   By the time either exists the goal is not «almost done», it is handed in.
 *
 * SO NO COLUMN WAS ADDED, and the reason is stronger than «it was not needed»:
 * an `achievement_requests.completed_units` column would have had NO WRITER.
 * Nothing in this product asks a child «how many have you done so far», and
 * inventing an endpoint so that a notification could fire would have put a
 * CHILD-CLAIMED number inside a server sentence — and shipped a producer whose
 * condition is FALSE FOREVER in production, which is `PF-E-001` wearing a migration.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE PROGRESS ACTUALLY IS: IT IS A COUNT OF ROWS, NOT A COLUMN.
 *
 * A program is not attempted once. `reward_programs.max_per_day` is the number
 * of times a parent's plan expects this goal to be completed on one day, and
 * `checkProgramEligibility` ENFORCES it — `verifiedToday >= maxPerDay` is
 * `MAX_PER_DAY_REACHED` and the child cannot start another. Every completed unit
 * of that plan is an `achievement_requests` row with `status = 'VERIFIED'`,
 * written by the server (or by a parent's confirmation) and never claimed by the
 * child.
 *
 * So «أنجزت ٤ من ٥ — هل تكمل الأخيرة الآن؟» is not an inference. It is:
 *
 *   COUNT(VERIFIED attempts of THIS program by THIS child on THIS family-local
 *   day) = `max_per_day` - 1, AND ANOTHER ONE CAN ACTUALLY BE STARTED RIGHT NOW.
 *
 * THE SECOND HALF IS NOT DECORATION. `SQL_LIST_ALMOST_DONE_GOALS` re-states, as
 * WHERE clauses, every gate `checkProgramEligibility` would apply — active, not
 * archived, not expired, addressed to this child, old enough, inside the WEEKLY
 * cap, no attempt already open. A nudge that invites a child to do something the
 * next screen refuses is worse than silence, and «the eligibility rule and the
 * nudge disagree» is the shape of that bug.
 *
 * ---------------------------------------------------------------------------
 * `GOAL_DEADLINE_NEAR` — THE OTHER ONE, WHICH WAS ALWAYS DETERMINISTIC.
 *
 * An OPEN attempt (`REQUESTED`/`IN_PROGRESS`, nothing submitted, nothing
 * decided) on a program whose `expires_at` is minutes away. The child is working
 * on it right now and the window is closing; this is the one moment in this
 * product where a reminder buys the child something they cannot get back.
 *
 * WHY THE BAND IS `3..10` MINUTES AND NOT THE RULE'S OWN `1..30`, and this is a
 * LANGUAGE constraint rather than a product one. The catalogue's sentence is
 * «باقي {minutes} دقائق», with «دقائق» — the Arabic plural of paucity, which is
 * correct for 3 to 10 and WRONG for everything else («٢٥ دقائق» reads to an
 * Arabic-speaking child the way «25 minuteses» reads in English). That sentence
 * is the product brief's own, byte-pinned by `notification-tone-and-copy.spec.ts`
 * as «the exact Arabic sentences the brief specifies», so the producer speaks
 * inside the band where the product's sentence is TRUE rather than rewriting the
 * product's sentence to fit a wider band.
 *
 * THE BAND IS REACHABLE BY CONSTRUCTION, which is the property that separates
 * this from a producer that exists and never fires. `minutesRemaining` is
 * `FLOOR(seconds_remaining / 60)`, so the band covers a continuous
 * `[3*60, 11*60)` seconds — EIGHT REAL MINUTES — and `goal-nudge-sweep` runs
 * every `300` seconds. A window strictly wider than the cadence cannot be
 * stepped over. `goal-nudge-producer.e2e.spec.ts` asserts that inequality
 * against the seeded `scheduled_jobs` row rather than against a constant here.
 *
 * ---------------------------------------------------------------------------
 * `unitNoun` HAD NO SERVER SOURCE, AND NOW IT HAS ONE THAT IS NOT A COLUMN.
 *
 * `notification-nouns.ts` carries the whole argument. In one line: the noun has
 * to agree with the household's LANGUAGE and with the NUMBER in front of it, and
 * a column on `reward_programs` could express neither. The producer states a
 * `GoalUnitKind`; the copy layer says the word; and when the count is one this
 * product cannot say correctly — the Arabic dual, which is not written after a
 * numeral — `canNameUnits` is false and THIS PRODUCER STAYS SILENT. A child gets
 * no message rather than a wrong plural or a `GENERIC` stub.
 *
 * ---------------------------------------------------------------------------
 * IT IS A NUDGE TO A CHILD, WHICH IS THE PART MOST LIKELY TO GO WRONG.
 *
 * These are the two sentences in this product most able to read as nagging, so
 * every bound below is a bound on pressure, not on cost:
 *
 *   ONE PER SWEEP        `sweepChild` tells the engine about at most ONE goal,
 *                        and the deadline beats the count — a child two minutes
 *                        from a closing window does not also need to hear about
 *                        their fifth session.
 *   ONE PER DAY PER FACT the dedup key is `forEntity('goal', childId, <fact>,
 *                        businessDate)`, so the five-minute cadence cannot
 *                        re-present the same fact 288 times.
 *   THE FATIGUE GUARD    unchanged, and `STUDY_REMINDER` already carries a
 *                        90-minute cooldown and a 2/day cap in
 *                        `DEFAULT_FATIGUE_POLICY`.
 *   QUIET HOURS          `STUDY_REMINDER` is a SUPPRESS class: a reminder whose
 *                        premise expired overnight is dropped WITH a recorded
 *                        reason, never deferred into a morning where it is false.
 *   NOTHING PUNITIVE     the producer never composes words. Every sentence is a
 *                        `COPY_CATALOGUE` template, age-banded, and the persisted
 *                        bytes are re-validated by the REAL
 *                        `ChildSafetyFilterService` in the e2e suite.
 *
 * ---------------------------------------------------------------------------
 * THE FAMILY'S CALENDAR, NEVER UTC. `local_date` was written by
 * `AchievementService.start` from `FamilyDateService.toDateColumn`, so it is
 * already a family-local day and is compared as one. The week bound is
 * `weekWindow`'s six CALENDAR days, not six times 86,400,000 milliseconds.
 * `expires_at` is a `timestamp` WITHOUT time zone holding a UTC instant, so
 * every comparison against it says `AT TIME ZONE 'UTC'` explicitly — comparing it
 * to a `timestamptz` bare would silently convert through the SESSION's zone,
 * i.e. the deployment's, which is the class of bug `family-date.ts` exists to
 * have removed.
 */

/**
 * WHICH OF THE TWO FACTS A CANDIDATE CARRIES. A closed union; a third is a
 * compile-time event.
 */
export type GoalNudgeKind = 'GOAL_DEADLINE' | 'GOAL_ALMOST_DONE';

/**
 * THE NOTIFICATION TYPE THIS PRODUCER MAY STATE, as a NAMED closed union of one.
 *
 * The name is load-bearing rather than cosmetic:
 * `notification-producer-chain.guard.spec.ts` resolves a door site's event type
 * by reading the declared type of the property it is given and expanding it, and
 * it can only expand a union it can look up BY NAME.
 *
 * `STUDY_REMINDER` AND NOT A NEW TYPE, for the reason `child-signal.types.ts`
 * gives for `STREAK_AT_RISK`: `GOAL_DEADLINE_NEAR` and `GOAL_ALMOST_DONE` are
 * COPY KEYS, not types — `COPY_CATALOGUE`'s own header says a key need not be a
 * type — and neither has a quiet-hours row, an urgency weight or an achievement
 * baseline. Minting a type to carry a sentence would have meant three new rows in
 * three tables and a fourth vocabulary for analytics to learn.
 *
 * `STUDY_REMINDER` is the honest carrier and not merely an available one: CHILD
 * audience, `REMINDER` category, quiet-hours `SUPPRESS` («the notification's only
 * premise has expired» by morning — true of both sentences), and
 * `DESTINATION_RULES.STUDY_REMINDER` is ALREADY `goalDestination`, the same
 * destination both goal keys have.
 */
export type GoalNudgeEventType = 'STUDY_REMINDER';

/**
 * ONE THING TO SAY TO ONE CHILD ABOUT ONE GOAL, already resolved to the facts
 * that will select its sentence.
 */
export interface GoalNudgeCandidate {
  readonly kind: GoalNudgeKind;
  readonly eventType: GoalNudgeEventType;
  readonly programId: string;
  /** `reward_programs.target_summary_ar` — the Arabic `describeTargetSpec`
   * derived once at program creation, which the child already reads on their own
   * goal card. The producer never composes a title. */
  readonly goalTitle: string;
  /** VERIFIED attempts of this program on the family-local day. */
  readonly completedUnits: number;
  /** `reward_programs.max_per_day` — the parent's own plan for the day. */
  readonly totalUnits: number;
  /** Whole minutes until `expires_at`, or `null` for the count sentence. */
  readonly minutesRemaining: number | null;
  /** What one completed attempt of this activity IS, so the copy layer can
   * inflect the noun. Never rendered itself. */
  readonly unitKind: GoalUnitKind;
}

/** What one child's sweep did. Counts only — no ids, no goal titles, nothing a
 * log aggregator turns into a profile. The same rule `StalledGoalService` and
 * `ChildSignalService` both follow. */
export interface GoalNudgeSweepReport {
  /** Conditions that held. May exceed `produced` — see `GOAL_NUDGE_PRIORITY`. */
  readonly candidates: number;
  /** Decisions the engine actually recorded, i.e. new causes. */
  readonly produced: number;
  /** The ledger's unique key refused the cause: already decided today. */
  readonly alreadyDecided: number;
  /** The engine looked and said no — quiet hours, a cap, the floor. */
  readonly refused: number;
}

export const EMPTY_GOAL_NUDGE_REPORT: GoalNudgeSweepReport = Object.freeze({
  candidates: 0,
  produced: 0,
  alreadyDecided: 0,
  refused: 0,
});

/** What one whole sweep did, across every household that had a candidate. This
 * object becomes `job_runs.details`, which is contractually counts and never
 * content. */
export interface GoalNudgeSweepTotals extends GoalNudgeSweepReport {
  readonly families: number;
  readonly children: number;
}

export const EMPTY_GOAL_NUDGE_TOTALS: GoalNudgeSweepTotals = Object.freeze({
  families: 0,
  children: 0,
  candidates: 0,
  produced: 0,
  alreadyDecided: 0,
  refused: 0,
});

/**
 * AT MOST ONE NUDGE PER SWEEP, AND THE ORDER IS «WHAT BECOMES IMPOSSIBLE IF I
 * WAIT» rather than «what scores highest» — the same rule, for the same reason,
 * as `CHILD_SIGNAL_PRIORITY`.
 *
 *   GOAL_DEADLINE      a window that closes in minutes and cannot be reopened.
 *   GOAL_ALMOST_DONE   true for the rest of the family's day.
 */
export const GOAL_NUDGE_PRIORITY: readonly GoalNudgeKind[] = Object.freeze([
  'GOAL_DEADLINE',
  'GOAL_ALMOST_DONE',
]);

/**
 * THE DEADLINE BAND, IN WHOLE MINUTES REMAINING, INCLUSIVE AT BOTH ENDS.
 *
 * `3` because «باقي {minutes} دقائق» is only correct Arabic for 3..10 (see the
 * header), and because a child told at minute 1 can do nothing with the
 * information except feel it.
 */
export const GOAL_DEADLINE_MIN_MINUTES = 3;

/** `10`, the top of the Arabic plural of paucity — and the whole band is
 * `[3*60, 11*60)` seconds, eight real minutes, which is what makes it wider
 * than the sweep's own 300-second cadence. */
export const GOAL_DEADLINE_MAX_MINUTES = 10;

/**
 * The dedup entity for each fact, and they are DIFFERENT strings on purpose:
 * «your window closes in five minutes» and «you have one session left today» are
 * two different things to be told about one goal, and collapsing them onto one
 * key would let the first silence the second for the rest of the day.
 *
 * Per PROGRAM, so a child with two goals hears about both — bounded by the
 * one-per-sweep rule above and by `STUDY_REMINDER`'s own 2/day cap rather than
 * by a key that hides the second goal entirely.
 */
export function goalNudgeEntityId(kind: GoalNudgeKind, programId: string): string {
  return `${kind}:${programId}`;
}

/** The family-local day a sweep is about, carried as a type rather than a bare
 * string so a caller cannot hand this file an instant by accident. */
export type GoalNudgeDay = BusinessDate;
