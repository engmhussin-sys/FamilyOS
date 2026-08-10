import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../../common/prisma/prisma.service';
import { IDigitalTwin, IExplainableSubScore } from '../../domain/digital-twin.types';

@Injectable()
export class PrismaDigitalTwinRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Social Score inputs \u2014 Architecture 1.0 \u00a76.2, Decision 1: only
   * legitimate in-platform data, zero surveillance, zero conversation/
   * contact data. */
  async getSocialScoreInputs(childId: string, sinceDate: Date): Promise<{
    sharedHabitCompletions: number;
    groupActivityCount: number;
    groupBadgeCount: number;
    challengeParticipations: number;
  }> {
    const [sharedHabitCompletions, groupActivityCount, groupBadgeCount, challengeParticipations] = await Promise.all([
      this.prisma.habitCompletion.count({ where: { childId, date: { gte: sinceDate }, habit: { isShared: true } } }),
      this.prisma.activityLog.count({ where: { childId, date: { gte: sinceDate }, socialContext: { in: ['GROUP', 'TEAM'] } } }),
      this.prisma.childBadgeAward.count({ where: { childId, awardedAt: { gte: sinceDate }, badge: { isGroupAchievement: true } } }),
      this.prisma.familyChallengeParticipation.count({ where: { childId, completedAt: { gte: sinceDate, not: null } } }),
    ]);

    return { sharedHabitCompletions, groupActivityCount, groupBadgeCount, challengeParticipations };
  }

  async upsertProjection(childId: string, slices: {
    healthSlice?: IExplainableSubScore | null;
    learningSlice?: IExplainableSubScore | null;
    faithSlice?: IExplainableSubScore | null;
    behaviorSlice?: IExplainableSubScore | null;
    habitsSlice?: IExplainableSubScore | null;
    socialSlice?: IExplainableSubScore | null;
    safetySlice?: IExplainableSubScore | null;
  }): Promise<void> {
    await this.prisma.childDigitalTwinProjection.upsert({
      where: { childId },
      create: { childId, ...(slices as Record<string, unknown>) },
      update: { ...(slices as Record<string, unknown>) },
    });
  }

  async getProjection(childId: string): Promise<IDigitalTwin | null> {
    const row = await this.prisma.childDigitalTwinProjection.findUnique({ where: { childId } });
    if (!row) return null;

    return {
      childId: row.childId,
      safety: (row.safetySlice as unknown as IExplainableSubScore | null) ?? null,
      health: (row.healthSlice as unknown as IExplainableSubScore | null) ?? null,
      learning: (row.learningSlice as unknown as IExplainableSubScore | null) ?? null,
      faith: (row.faithSlice as unknown as IExplainableSubScore | null) ?? null,
      behavior: (row.behaviorSlice as unknown as IExplainableSubScore | null) ?? null,
      habits: (row.habitsSlice as unknown as IExplainableSubScore | null) ?? null,
      social: (row.socialSlice as unknown as IExplainableSubScore | null) ?? null,
      growthScore: null,
      updatedAt: row.updatedAt,
    };
  }
}
