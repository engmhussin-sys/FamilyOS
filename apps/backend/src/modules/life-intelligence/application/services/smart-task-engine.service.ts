import { Injectable, NotFoundException } from '@nestjs/common';

import { ChildrenService } from '../../../children/application/services/children.service';
import { PrismaSmartTaskRepository } from '../../infrastructure/repositories/prisma-smart-task.repository';
import { ISmartTask, ISmartTaskContext } from '../../domain/smart-task.types';
import { generateSmartTasks } from './smart-task-rules';
import { HealthEngineService } from './health-engine.service';
import { HabitEngineService } from './habit-engine.service';
import { FamilyDateService } from '../../../../common/time/family-date.service';
import { getBusinessDate } from '../../../../common/time/family-date';

/**
 * Architecture 1.0 §3/§5: AI-generated, context-driven, DYNAMIC
 * suggestions — deliberately distinct from Habit Builder's static,
 * parent-defined list. "AI-generated" here means the generation LOGIC
 * is deterministic (see smart-task-rules.ts); no LLM call happens in
 * this sprint's implementation — the architecture leaves room for an
 * LLM to reword generatedReason/title later without ever letting it
 * decide WHICH tasks to suggest, matching this project's own AI
 * Freeze discipline.
 *
 * CLOSES A REAL DESIGN FLAW found in a systematic frontend/backend
 * audit: generateForToday (unchanged below) required its CALLER to
 * manually compute the context (sleep/hydration/missed-habits/
 * screen-time) — meaning zero frontend anywhere could actually use
 * "Smart" Task generation without duplicating real analytical logic
 * client-side, which is exactly backwards for a feature whose whole
 * point is server-side intelligence. generateForTodayAuto (new,
 * additive) computes that context from REAL data via already-built
 * engines instead — the fix belongs here, once, not duplicated in
 * every future frontend that might call this.
 *
 * Future-Engine Contract (Architecture 1.0 §2): no Memory/Audit/Safety
 * usage this sprint; Events: none yet — accepting/dismissing a
 * suggestion doesn't obviously belong on the Timeline the way a FIRST
 * completion does, left open rather than guessed at.
 */
@Injectable()
export class SmartTaskEngineService {
  constructor(
    private readonly repository: PrismaSmartTaskRepository,
    private readonly childrenService: ChildrenService,
    private readonly healthEngine: HealthEngineService,
    private readonly habitEngine: HabitEngineService,
    private readonly familyDate: FamilyDateService,
  ) {}

  async generateForToday(childId: string, familyId: string, context: Omit<ISmartTaskContext, 'childId'>): Promise<number> {
    await this.childrenService.assertChildBelongsToFamily(childId, familyId);

    const suggestions = generateSmartTasks({ ...context, childId });
    if (suggestions.length === 0) return 0;

    return this.repository.createMany(childId, suggestions, await this.todayColumn(familyId), context as unknown as Record<string, unknown>);
  }

  /** CLOSES A REAL DESIGN FLAW — see this class's own docstring.
   * Computes real context from already-built engines instead of
   * trusting a caller to supply it:
   *   - lateSleepLastNight: approximated from
   *     computeAndStoreHealthScore's own sleepHours (< 7h counted as
   *     insufficient) — an honest, documented approximation of
   *     "late," not a literal bedtime comparison (no engine
   *     currently exposes raw sleepStart/End to this layer without a
   *     new repository dependency this fix deliberately avoids
   *     adding).
   *   - lowHydrationToday: getDailyProgress's own real
   *     hydration.isAchieved (Sprint 15/16.1/16.3), inverted.
   *   - missedHabitsYesterday: getMissedHabitsSignal's own real data,
   *     windowed to yesterday specifically (1 day), not the 7-day
   *     default that method uses elsewhere.
   *   - screenTimeOverLimit: HONESTLY left false, always, with this
   *     documented reason — computing it correctly needs the
   *     child's real Screen Time Policy limit (a different module,
   *     screen-time, not life-intelligence) compared against today's
   *     real usage. A real, separate, undecided integration — not
   *     invented here with an unfounded guess for something this
   *     sensitive. */
  async generateForTodayAuto(childId: string, familyId: string): Promise<number> {
    await this.childrenService.assertChildBelongsToFamily(childId, familyId);

    const [healthScore, dailyProgress, missedYesterday] = await Promise.all([
      this.healthEngine.computeAndStoreHealthScore(childId, familyId),
      this.healthEngine.getDailyProgress(childId, familyId),
      this.habitEngine.getMissedHabitsSignal(childId, familyId, 1),
    ]);

    const context: Omit<ISmartTaskContext, 'childId'> = {
      lateSleepLastNight: healthScore.breakdown.sleepHours !== null && healthScore.breakdown.sleepHours < 7,
      lowHydrationToday: !dailyProgress.hydration.isAchieved,
      missedHabitsYesterday: missedYesterday.map((m) => m.habitTitle),
      screenTimeOverLimit: false,
    };

    return this.generateForToday(childId, familyId, context);
  }

  async listForToday(childId: string, familyId: string): Promise<ISmartTask[]> {
    await this.childrenService.assertChildBelongsToFamily(childId, familyId);
    return this.repository.listForChildOnDate(childId, await this.todayColumn(familyId));
  }

  async decide(taskId: string, childId: string, familyId: string, status: 'ACCEPTED' | 'DISMISSED' | 'COMPLETED'): Promise<void> {
    await this.childrenService.assertChildBelongsToFamily(childId, familyId);

    const task = await this.repository.findById(taskId);
    if (!task || task.childId !== childId) {
      throw new NotFoundException('Smart task not found');
    }

    await this.repository.updateStatus(taskId, status);
  }

  /** B2: a Smart Task generated "for today" and one listed "for today" must
   * mean the same day, and that day is the family's — otherwise the Child App's
   * Today screen goes empty for three hours after local midnight while the
   * generator has already moved on. */
  private async todayColumn(familyId: string): Promise<Date> {
    const tz = await this.familyDate.timeZoneOf(familyId);
    return FamilyDateService.toDateColumn(getBusinessDate(new Date(), tz));
  }
}
