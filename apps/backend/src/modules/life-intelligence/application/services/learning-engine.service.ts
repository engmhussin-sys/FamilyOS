import { Inject, Injectable } from '@nestjs/common';

import { ChildrenService } from '../../../children/application/services/children.service';
import { PrismaLearningRepository } from '../../infrastructure/repositories/prisma-learning.repository';
import { REWARD_TRIGGER_WRITER, IRewardTriggerWriter } from '../../domain/reward-trigger.types';
import { ICreateLearningGoalInput, ICreateLearningSessionInput, ILearningGoal, ILearningProgressSummary, ILearningSession } from '../../domain/learning.types';
import { computeCurrentStreak } from './streak-calculator';
import { FamilyDateService } from '../../../../common/time/family-date.service';
import { getBusinessDate, isBusinessDate } from '../../../../common/time/family-date';

const PROGRESS_WINDOW_DAYS = 30;
const STREAK_MILESTONES = [3, 7, 14, 30, 60, 100];

/**
 * Architecture 1.0 §3/§5: school study, languages, reading, homework,
 * courses, tests. Quran memorization/review explicitly excluded —
 * that lives in the independent Faith Engine per the approved decision.
 *
 * Sprint 16.3 Priority 2 — CLOSES A REAL GAP confirmed in Sprint
 * 16.2's own E2E re-audit (direct grep confirmed zero rewardTrigger
 * call existed anywhere in this file — the "Streak -> Reward" hop
 * was entirely missing from Education's chain). Mirrors
 * HabitEngineService/HealthEngineService/FaithEngineService's own
 * EXACT pattern:
 *   - EDUCATION_TASK_COMPLETED fires on every session log (the
 *     brief's own explicit Sprint 16 contract event name).
 *   - STREAK_ACHIEVED fires only at real milestone lengths (3/7/14/
 *     30/60/100 days), not every day — matches every other engine's
 *     own "Timeline/notification gets curated moments, not every
 *     tick" discipline.
 *   - idempotencyKey (Sprint 16.1 Double Reward Protection) — a
 *     retry/duplicate logSession call for the SAME real-world event
 *     must not grant the same reward twice.
 *   - Best-effort: a Reward Rules failure never blocks the session
 *     log itself from succeeding — same principle as every other
 *     engine's identical reasoning.
 *
 * Future-Engine Contract (Architecture 1.0 §2): no Memory/Audit/Safety
 * usage yet. No Timeline write for "first learning session" — left as
 * a real, separate, undecided product question (unchanged from
 * before this sprint) — the REWARD system's OWN Timeline writes
 * (badge_awarded/level_up, written only on a real, successful grant)
 * are what now correctly appear when a Learning-sourced reward is
 * actually earned, via RewardsEngineService's own established
 * "Timeline only on real success" discipline — nothing new needed
 * here to satisfy that.
 */
@Injectable()
export class LearningEngineService {
  constructor(
    private readonly repository: PrismaLearningRepository,
    private readonly childrenService: ChildrenService,
    private readonly familyDate: FamilyDateService,
    @Inject(REWARD_TRIGGER_WRITER) private readonly rewardTrigger: IRewardTriggerWriter,
  ) {}

  async createGoal(childId: string, familyId: string, input: Omit<ICreateLearningGoalInput, 'childId'>): Promise<ILearningGoal> {
    await this.childrenService.assertChildBelongsToFamily(childId, familyId);
    return this.repository.createGoal({ ...input, childId });
  }

  async listGoals(childId: string, familyId: string): Promise<ILearningGoal[]> {
    await this.childrenService.assertChildBelongsToFamily(childId, familyId);
    return this.repository.listActiveGoals(childId);
  }

  /**
   * B1 (PA-B-004) + B2. `input.date` used to be a device-supplied string that
   * went straight into the reward idempotency key
   * (`education-session:{child}:{subject}:{date}`) — the same replay exploit as
   * PA-B-003, on a route outside `/events/batch` and outside its throttler.
   * `actor` now decides whether it is honoured at all, exactly as in
   * `HabitEngineService.completeHabit`, and DEVICE is the default.
   */
  async logSession(
    childId: string,
    familyId: string,
    input: Omit<ICreateLearningSessionInput, 'childId'>,
    actor: 'PARENT' | 'DEVICE' = 'DEVICE',
  ): Promise<ILearningSession> {
    await this.childrenService.assertChildBelongsToFamily(childId, familyId);

    const timeZone = await this.familyDate.timeZoneOf(familyId);
    const todayStr = getBusinessDate(new Date(), timeZone);
    const sessionDateStr = this.resolveSessionDate(input.date, todayStr, actor, timeZone);
    // The resolved business date replaces whatever the caller sent. The
    // repository anchors it with `new Date(input.date)`, and a bare
    // `YYYY-MM-DD` parses as UTC midnight — the `@db.Date` storage convention.
    const session = await this.repository.createSession({ ...input, childId, date: sessionDateStr });

    // Sprint 16.3 Priority 2 — CLOSES A REAL GAP: best-effort, same
    // discipline as every other engine — a Reward Rules failure must
    // never block the session log itself, which already succeeded above.
    try {
      await this.rewardTrigger.trigger(childId, familyId, {
        engine: 'learning',
        type: 'EDUCATION_TASK_COMPLETED',
        payload: { subject: input.subject, durationMinutes: input.durationMinutes },
        // Idempotent per (childId, subject, date) — a retry/duplicate
        // log for the SAME subject on the SAME day must not grant
        // this reward twice. Distinct sessions on different subjects
        // the same day (a real, valid, separate learning event each)
        // correctly get distinct keys.
        idempotencyKey: `education-session:${childId}:${input.subject}:${sessionDateStr}`,
      });

      const since = this.daysAgo(30, timeZone);
      const sessionDates = await this.repository.findDistinctSessionDates(childId, since);
      const streakDays = computeCurrentStreak(sessionDates, todayStr);
      if (STREAK_MILESTONES.includes(streakDays)) {
        await this.rewardTrigger.trigger(childId, familyId, {
          engine: 'learning',
          type: 'STREAK_ACHIEVED',
          payload: { metric: 'education', streakDays },
          idempotencyKey: `streak:${childId}:education:${streakDays}`,
        });
      }
    } catch {
      // Intentionally swallowed — see this method's own docstring.
    }

    return session;
  }

  /** Feeds the Learning Score sub-component of the Digital Twin
   * (Architecture 1.0). Sprint 16.1 Phase 5 — reuses computeCurrentStreak
   * exactly as already tested — zero duplicated logic. */
  async getProgressSummary(childId: string, familyId: string): Promise<ILearningProgressSummary> {
    await this.childrenService.assertChildBelongsToFamily(childId, familyId);

    const timeZone = await this.familyDate.timeZoneOf(familyId);
    const since = this.daysAgo(PROGRESS_WINDOW_DAYS, timeZone);
    const totalSessions = await this.repository.countSessionsInWindow(childId, since);
    const totalMinutes = await this.repository.sumSessionMinutesInWindow(childId, since);
    const averageAssessmentScore = await this.repository.averageAssessmentScoreInWindow(childId, since);

    const sessionDates = await this.repository.findDistinctSessionDates(childId, since);
    const streakDays = computeCurrentStreak(sessionDates, getBusinessDate(new Date(), timeZone));

    return { childId, windowDays: PROGRESS_WINDOW_DAYS, totalSessions, totalMinutes, averageAssessmentScore, streakDays };
  }

  private daysAgo(days: number, timeZone: string): Date {
    return FamilyDateService.toDateColumn(
      FamilyDateService.addDays(getBusinessDate(new Date(), timeZone), -days),
    );
  }

  /** B1 (PA-B-004): the same bounded-back-fill rule the Habit engine applies. */
  private resolveSessionDate(
    dateStr: string | undefined,
    todayStr: string,
    actor: 'PARENT' | 'DEVICE',
    timeZone: string,
  ): string {
    if (actor !== 'PARENT' || dateStr === undefined) return todayStr;
    const requested = isBusinessDate(dateStr) ? dateStr : getBusinessDate(new Date(dateStr), timeZone);
    if (requested > todayStr) return todayStr;
    const earliest = FamilyDateService.addDays(todayStr, -PROGRESS_WINDOW_DAYS);
    return requested < earliest ? earliest : requested;
  }
}
