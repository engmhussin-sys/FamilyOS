import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../../../common/prisma/prisma.service';
import { tenantIdForWrite } from '../../../../common/tenancy/tenant-context';
import { isUniqueViolation } from '../outbox.writer';

/**
 * The consumed-messages table, in service form.
 *
 * WHAT IT IS: a fast path. At-least-once delivery means every consumer WILL be
 * handed the same message again; this stops the second attempt before it does
 * any work, which saves the round-trips and keeps the logs readable.
 *
 * WHAT IT IS NOT — and this is the honest part: it is NOT the guarantee. The
 * order below is `run the work, then mark`, so a crash between the two replays
 * the work. That is deliberate. The alternative order (`mark, then run`) turns
 * a crash into SILENTLY LOST work, which is far worse than repeated work when
 * the work itself is idempotent. It is idempotent:
 *
 *   RewardsCompletionConsumer -> `rewards_ledger_entries (child_id,
 *       idempotency_key)` UNIQUE, enforced by `INSERT ... ON CONFLICT DO
 *       NOTHING` in rewards.sql.ts. A2 §7.3 measured what happens without it.
 *   StreakDetectionConsumer   -> recomputes the streak from completion rows and
 *       emits through the outbox, whose `domain_events (family_id,
 *       idempotency_key)` UNIQUE absorbs the repeat.
 *   NotificationRewardConsumer-> NotificationFatigueGuard's 5-minute DUPLICATE
 *       window suppresses the repeat; the underlying REWARD_GRANTED event
 *       cannot itself be duplicated, by the same unique index.
 *
 * So: this table is an optimisation with an audit trail attached, and the
 * database constraints are the correctness argument.
 */
@Injectable()
export class ConsumerIdempotency {
  private readonly logger = new Logger(ConsumerIdempotency.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Runs `work` unless this consumer has already recorded this event.
   * Returns `{ skipped: true }` when the marker was already present.
   */
  async once<T>(
    consumerName: string,
    domainEventId: string,
    work: () => Promise<T>,
  ): Promise<{ skipped: boolean; result: T | null }> {
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    const client = this.prisma as any;

    const existing = await client.consumedMessage.findFirst({
      where: { consumerName, domainEventId },
      select: { id: true },
    });
    if (existing) {
      this.logger.debug(`consumer.skip_duplicate consumer=${consumerName} eventId=${domainEventId}`);
      return { skipped: true, result: null };
    }

    const result = await work();

    try {
      await client.consumedMessage.create({
        data: {
          familyId: tenantIdForWrite(),
          consumerName,
          domainEventId,
          outcome: 'HANDLED',
        },
        select: { id: true },
      });
    } catch (err) {
      // Two relay instances raced and both did the work. The work itself was
      // idempotent (see the class docstring), so the loser simply does not
      // write a second marker. Swallowing anything else would hide a real bug.
      if (!isUniqueViolation(err)) throw err;
    }

    return { skipped: false, result };
  }
}
