import { Inject, Injectable, NotFoundException } from '@nestjs/common';

import { ChildrenService } from '../../../children/application/services/children.service';
import { PrismaFaithRepository } from '../../infrastructure/repositories/prisma-faith.repository';
import { LIFE_TIMELINE_WRITER, ILifeTimelineWriter } from '../../domain/life-timeline.types';
import { TIMELINE_COPY_AR } from '../../domain/life-timeline-copy';
import { REWARD_TRIGGER_WRITER, IRewardTriggerWriter } from '../../domain/reward-trigger.types';
import { IFaithPractice, IFaithPracticeLog, IFaithScoreBreakdown, ICreateFaithPracticeInput } from '../../domain/faith.types';
import { FamilyDateService } from '../../../../common/time/family-date.service';
import { getBusinessDate, isBusinessDate } from '../../../../common/time/family-date';

const SCORE_WINDOW_DAYS = 30;

/**
 * Architecture 1.0 \u00a73/\u00a75: independent engine (Quran memorization/
 * review moved OUT of Learning & Education entirely, per the approved
 * decision).
 *
 * Future-Engine Contract (Architecture 1.0 \u00a72): Events via the
 * Unified Timeline, and (Sprint 25) Reward Rules via
 * IRewardTriggerWriter \u2014 the payload includes `streakDays` so a real
 * rule like Architecture 1.0's own "SALAH, 7-day streak" example can
 * actually match.
 */
@Injectable()
export class FaithEngineService {
  constructor(
    private readonly repository: PrismaFaithRepository,
    private readonly childrenService: ChildrenService,
    @Inject(LIFE_TIMELINE_WRITER) private readonly timeline: ILifeTimelineWriter,
    @Inject(REWARD_TRIGGER_WRITER) private readonly rewardTrigger: IRewardTriggerWriter,
    private readonly familyDate: FamilyDateService,
  ) {}

  async createPractice(childId: string, familyId: string, input: Omit<ICreateFaithPracticeInput, 'childId'>): Promise<IFaithPractice> {
    await this.childrenService.assertChildBelongsToFamily(childId, familyId);
    return this.repository.createPractice({ ...input, childId });
  }

  async listPractices(childId: string, familyId: string): Promise<IFaithPractice[]> {
    await this.childrenService.assertChildBelongsToFamily(childId, familyId);
    return this.repository.listActivePractices(childId, await this.todayColumn(familyId));
  }

  /**
   * B4 — `actor`, AND WHY IT HAD TO ARRIVE WITH THE REWARD.
   *
   * Until B4 this method took `dateStr` from whoever called it, and
   * `POST /life-intelligence/self/faith/:practiceId/log` — a DEVICE-token route
   * — passed `dto.date` straight through. That is PA-B-004's exact shape, and
   * B1 closed it on the habit and learning routes but not here, for one reason:
   * FAITH GRANTED NOTHING, so a chosen date bought a chosen row and no more.
   *
   * B4 connects faith to the reward engine, which turns the same input into a
   * chosen IDEMPOTENCY KEY — `faith-practice:{practiceId}:{businessDate}` — and
   * a chosen key mints unlimited rewards. So the gate lands in the same commit
   * as the grant, never after it. `'DEVICE'` is the default, i.e. the safe
   * side: a future call site that forgets to declare an actor gets the derived
   * date, not the supplied one.
   */
  async logPractice(
    practiceId: string,
    childId: string,
    familyId: string,
    dateStr?: string,
    progress?: Record<string, unknown>,
    actor: 'PARENT' | 'DEVICE' = 'DEVICE',
  ): Promise<IFaithPracticeLog> {
    await this.childrenService.assertChildBelongsToFamily(childId, familyId);

    const practice = await this.repository.findPracticeById(practiceId);
    if (!practice || practice.childId !== childId) {
      throw new NotFoundException('Faith practice not found');
    }

    // B2: which day a Salah/Quran practice belongs to is a FAMILY calendar
    // question — a dawn prayer logged at 04:00 in Cairo is 02:00 UTC of the
    // same day, but the evening ones are the previous UTC day, so the old
    // implementation split a single day's practices across two.
    const timeZone = await this.familyDate.timeZoneOf(familyId);
    const todayStr = getBusinessDate(new Date(), timeZone);
    const businessDate = this.resolveLogDate(dateStr, todayStr, actor, timeZone);
    const date = FamilyDateService.toDateColumn(businessDate);
    const log = await this.repository.recordLog(practiceId, childId, date, progress);

    const totalLogsForPractice = await this.repository.countPracticeLogsTotal(practiceId);
    // Same known, low-severity race condition as HabitEngineService's
    // identical pattern (see its own comment) — a rare, cosmetic
    // duplicate Timeline entry under concurrent requests, never
    // affecting the underlying FaithPracticeLog record itself.
    if (totalLogsForPractice === 1) {
      await this.timeline.record({
        childId,
        sourceEngine: 'faith',
        category: 'FAITH',
        eventType: 'first_practice_log',
        title: TIMELINE_COPY_AR.firstPracticeLog(practice.title),
      });
    }

    // Sprint 25: fires on EVERY log — a streak rule needs every
    // occurrence counted. Best-effort, matching HabitEngineService's
    // own reasoning: a Reward Rules failure never blocks the practice
    // log itself from succeeding.
    try {
      // LEGACY, KEYLESS, AND NOW UNREACHABLE BY ANY MANAGED RULE. Kept because
      // a family may hold a pre-B4 wildcard rule that depends on this name.
      // `practice_logged` is deliberately NOT in `RULE_EVENT_TYPES`, so no
      // platform default and no parent-authored rule can ever match it — which
      // is what stops one practice log being paid twice, once here without a
      // key and once below with one (PA-B-013).
      await this.rewardTrigger.trigger(childId, familyId, {
        engine: 'faith',
        type: 'practice_logged',
        payload: { practiceType: practice.type, streakDays: totalLogsForPractice },
      });

      // B4 — THE KEYED TRIGGER THAT CONNECTS FAITH.
      //
      // THE VERIFICATION CONDITION IS THE ROW ABOVE. `recordLog` has already
      // written a real `FaithPracticeLog` for (practice, child, business date)
      // before this line runs, and it is that write — not a timer, not a
      // client assertion — that the reward is paid for. If it throws, this is
      // never reached.
      //
      // KEY COMPOSITION, and which category it falls into: the key carries a
      // DAY component, so it belongs to the class Phase A called EXPLOITABLE
      // rather than STRUCTURALLY IMMUNE. It is replay-safe only because
      // `businessDate` is a SERVER output — `Family.timezone` applied to the
      // server clock for a device, or a bounded parent back-fill — which is
      // exactly the invariant B1 established and the `actor` gate above
      // enforces. Same category as HABIT_COMPLETED, same defence.
      await this.rewardTrigger.trigger(childId, familyId, {
        engine: 'faith',
        type: 'FAITH_PRACTICE_COMPLETED',
        payload: {
          practiceType: practice.type,
          streakDays: totalLogsForPractice,
          // Read by a rule that sets a `minVerifiedBy` floor. A practice log is
          // asserted by whoever called: a parent's own session is PARENT
          // evidence, a child's device is SELF.
          verifiedBy: actor === 'PARENT' ? 'PARENT' : 'SELF',
        },
        idempotencyKey: `faith-practice:${practiceId}:${businessDate}`,
      });
    } catch {
      // Intentionally swallowed — see comment above.
    }

    return log;
  }

  /**
   * B1 (PA-B-004) applied to Faith by B4, mirroring
   * `HabitEngineService.resolveCompletionDate` exactly rather than inventing a
   * second set of bounds: never the future (a future date pre-mints keys for
   * days that have not happened), never further back than the score window (a
   * date beyond it moves no score and no streak, and only widens the key
   * space).
   */
  private resolveLogDate(
    dateStr: string | undefined,
    todayStr: string,
    actor: 'PARENT' | 'DEVICE',
    timeZone: string,
  ): string {
    if (actor !== 'PARENT' || dateStr === undefined) return todayStr;

    const requested = isBusinessDate(dateStr) ? dateStr : getBusinessDate(new Date(dateStr), timeZone);
    if (requested > todayStr) return todayStr;
    const earliest = FamilyDateService.addDays(todayStr, -SCORE_WINDOW_DAYS);
    return requested < earliest ? earliest : requested;
  }

  /** Feeds the Faith Score sub-component of the Digital Twin
   * (Architecture 1.0 \u00a76.2). */
  async getScoreBreakdown(childId: string, familyId: string): Promise<IFaithScoreBreakdown> {
    await this.childrenService.assertChildBelongsToFamily(childId, familyId);

    const since = await this.daysAgo(familyId, SCORE_WINDOW_DAYS);
    const activePractices = await this.repository.countActivePractices(childId);
    const completedLogs = await this.repository.countLogsInWindow(childId, since);
    const totalPossible = activePractices * SCORE_WINDOW_DAYS;

    return {
      childId,
      windowDays: SCORE_WINDOW_DAYS,
      activePractices,
      completedLogs,
      completionRate: totalPossible > 0 ? completedLogs / totalPossible : 0,
    };
  }

  /** Today on the family calendar, as the `@db.Date` column value. */
  private async todayColumn(familyId: string): Promise<Date> {
    const tz = await this.familyDate.timeZoneOf(familyId);
    return FamilyDateService.toDateColumn(getBusinessDate(new Date(), tz));
  }

  private async daysAgo(familyId: string, days: number): Promise<Date> {
    const tz = await this.familyDate.timeZoneOf(familyId);
    return FamilyDateService.toDateColumn(
      FamilyDateService.addDays(getBusinessDate(new Date(), tz), -days),
    );
  }
}
