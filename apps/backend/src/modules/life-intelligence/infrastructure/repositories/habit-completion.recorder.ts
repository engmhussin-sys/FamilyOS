/**
 * ============================================================================
 * THE ONE WRITER OF `habit_completions`, AND THE ONE RULE FOR ITS STATUS.
 * ============================================================================
 *
 * WHAT WENT WRONG, MEASURED against real PostgreSQL. That table had TWO writers
 * and they had already diverged by one line:
 *
 *   prisma-habit.repository.ts#recordCompletion      upsert … update: { status }
 *   event-ingestion.service.ts#writeHabitCompletion  upsert … update: {}
 *                                                    create status hardcoded COMPLETED
 *
 * `family-daily-rollover` writes yesterday's `MISSED` row for every active habit
 * with no completion. An offline device syncing that completion the next
 * morning — well inside the 48-hour skew `EventIngestionService` accepts — hit
 * the SECOND writer, whose `update: {}` touched nothing. THE ROW STAYED
 * `MISSED`.
 *
 * And the two halves of one fact then disagreed:
 * `findDistinctCompletionDates` filters `status IN (COMPLETED, COMPLETED_LATE)`,
 * so the day was not in the streak — while the domain event went on to the
 * Rewards Engine and the completion WAS PAID. The child was paid for a day the
 * product still recorded as missed, and their streak was broken by a completion
 * they had actually made. `test/life-intelligence/habit-completion-one-door.e2e.spec.ts`
 * reproduces exactly that and reads the ROW.
 *
 * WHY THIS FILE IS A FUNCTION AND NOT A METHOD ON THE REPOSITORY. The ingest
 * door writes inside a `$transaction`, together with the outbox row, because a
 * completion that is stored without its event is a lost reward. It therefore
 * needs the TRANSACTION CLIENT, and a repository method bound to `this.prisma`
 * cannot be given one. The function takes the client, so both doors execute the
 * same statement — `PrismaHabitRepository.recordCompletion` is now a thin
 * delegation, and the transactional caller passes `tx`.
 *
 * NO NEW CONSTRAINT IS INVENTED HERE. Idempotency is, as everywhere in this
 * codebase, `habit_completions (habit_id, date)` — a real UNIQUE index. This
 * function does not check-then-insert; it upserts onto that index and lets
 * PostgreSQL decide.
 */
import { getBusinessTimeHHMM } from '../../../../common/time/family-date';
import type { HabitCompletionStatus, IHabitCompletion } from '../../domain/habit.types';

/**
 * The subset of the Prisma client this needs. Satisfied by `PrismaService`, by a
 * `$transaction` client, and by nothing that would surprise a reader.
 */
export interface HabitCompletionClient {
  habitCompletion: {
    upsert(args: {
      where: { habitId_date: { habitId: string; date: Date } };
      create: {
        familyId: string;
        habitId: string;
        childId: string;
        date: Date;
        status: HabitCompletionStatus;
      };
      update: { status: HabitCompletionStatus };
    }): Promise<{
      id: string;
      habitId: string;
      childId: string;
      date: Date;
      completedAt: Date;
      status: string;
    }>;
  };
}

export interface RecordHabitCompletionInput {
  readonly familyId: string;
  readonly habitId: string;
  readonly childId: string;
  /** The FAMILY's business day, already anchored to the UTC midnight the
   *  `@db.Date` column stores it at. Never a raw device string. */
  readonly date: Date;
  readonly status: HabitCompletionStatus;
}

/**
 * Writes (or promotes) the completion row for one habit on one business day.
 *
 * `update: { status }` IS THE LOAD-BEARING HALF, and it is what the ingest door
 * was missing. A row that says `MISSED` is an INFERENCE — the rollover job saw
 * no completion and wrote one down. A completion arriving afterwards is
 * EVIDENCE, and evidence beats an inference about the same day. `update: {}`
 * kept the inference and threw the evidence away.
 */
export async function recordHabitCompletion(
  client: HabitCompletionClient,
  input: RecordHabitCompletionInput,
): Promise<IHabitCompletion> {
  const row = await client.habitCompletion.upsert({
    where: { habitId_date: { habitId: input.habitId, date: input.date } },
    create: {
      familyId: input.familyId,
      habitId: input.habitId,
      childId: input.childId,
      date: input.date,
      status: input.status,
    },
    update: { status: input.status },
  });

  return {
    id: row.id,
    habitId: row.habitId,
    childId: row.childId,
    date: row.date,
    completedAt: row.completedAt,
    status: row.status as HabitCompletionStatus,
  };
}

export interface HabitCompletionStatusInput {
  /** `"HH:MM"` on the family's clock, or `null` for a habit with no window —
   *  a habit with no scheduled end is never late. */
  readonly scheduledEndTime: string | null;
  /** The business day this completion is being recorded FOR. */
  readonly businessDate: string;
  /** The family's business day AT THE MOMENT OF RECORDING. */
  readonly todayBusinessDate: string;
  /** The instant the completion happened, as the server knows it. */
  readonly at: Date;
  readonly timeZone: string;
}

/**
 * ON TIME OR LATE — ONE ANSWER, FOR BOTH DOORS.
 *
 * This was a private method on `HabitEngineService`, which is why the ingest
 * door could not produce `COMPLETED_LATE` at all: it hardcoded `COMPLETED`, so
 * the same habit finished at the same hour was on time or late depending on
 * whether the child's phone was online.
 *
 * Lateness is only meaningful for a completion being recorded FOR TODAY. A day
 * that is already over has elapsed past every window it contained, so calling
 * every back-filled completion «late» would say nothing — the same reasoning
 * the direct door has always applied, now applied by both.
 *
 * B2, SERVER-LOCAL CLASS, CARRIED OVER WITH THE CODE. This comparison used to be
 * `new Date().setHours(h, m, 0, 0)` — which reads the CONTAINER's timezone. That
 * is neither UTC nor the family's, it is unset in this image (so it silently
 * equals UTC today), and it would change the meaning of every habit's scheduled
 * window the first time the service was deployed to a host configured
 * differently. A behaviour that depends on an undocumented, unpinned environment
 * variable is not a behaviour. Both sides are plain `HH:MM` strings on the
 * family's calendar, so there is no `Date` arithmetic left to be wrong.
 */
export function habitCompletionStatus(
  input: HabitCompletionStatusInput,
): Extract<HabitCompletionStatus, 'COMPLETED' | 'COMPLETED_LATE'> {
  if (input.businessDate !== input.todayBusinessDate) return 'COMPLETED';
  if (!input.scheduledEndTime) return 'COMPLETED';

  const [hours, minutes] = input.scheduledEndTime.split(':').map(Number);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return 'COMPLETED';

  const scheduledEnd = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  return getBusinessTimeHHMM(input.at, input.timeZone) > scheduledEnd
    ? 'COMPLETED_LATE'
    : 'COMPLETED';
}
