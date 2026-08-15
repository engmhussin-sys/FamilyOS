/* eslint-disable @typescript-eslint/no-explicit-any */
import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../../common/prisma/prisma.service';
import type {
  IScreenTimeBonusGrant,
  IScreenTimeBonusRepository,
} from '../../application/ports/screen-time.repository.port';

/**
 * F4 — THE READ SIDE OF `SCREEN_TIME` REWARDS, and it lives HERE on purpose.
 *
 * `screen_time_reward_grants` has exactly one writer (the Rewards Engine, after
 * a real ledger row) and exactly one reader (this module, which owns the
 * question "how many minutes may this child have today?"). Splitting it that
 * way is what stops the two modules importing each other, and it is why
 * `ScreenTimeService` did not have to learn what an achievement is.
 *
 * WHAT IS DELIBERATELY NOT DONE: the base `ScreenTimePolicy` row is NEVER
 * edited by a reward. A reward that rewrote a parental control would be
 * permanent, invisible in the policy history, and impossible to expire. The
 * bonus is a separate, expiring, revocable addend applied at read time.
 */
@Injectable()
export class PrismaScreenTimeBonusRepository implements IScreenTimeBonusRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listActiveGrants(childId: string, now: Date): Promise<IScreenTimeBonusGrant[]> {
    const rows = await (this.prisma as any).screenTimeRewardGrant.findMany({
      where: { childId, revokedAt: null, expiresAt: { gt: now } },
      orderBy: { expiresAt: 'asc' },
      select: { id: true, minutes: true, grantedAt: true, expiresAt: true },
    });
    return rows.map((r: any) => ({
      id: r.id,
      minutes: r.minutes,
      grantedAt: r.grantedAt,
      expiresAt: r.expiresAt,
    }));
  }
}
