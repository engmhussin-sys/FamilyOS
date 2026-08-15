/* eslint-disable @typescript-eslint/no-explicit-any */
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { ConsumerIdempotency } from '../../../events/application/consumers/consumer-idempotency.service';
import { OutboxWriter } from '../../../events/application/outbox.writer';
import { EVENT_SUBSCRIBER, type IEventSubscriber } from '../../../events/domain/event-bus.port';
import type { DomainEventEnvelope } from '../../../../shared/events/event-envelope';
import { composeIdempotencyKey } from '../../../../shared/events/idempotency';
import {
  BASE_MULTIPLIER_BPS,
  achievementGrantKeyPrefix,
} from '../../../../shared/rewards/streak-multiplier';
import { PrismaRewardProgramRepository } from '../../infrastructure/repositories/prisma-reward-program.repository';
import { RewardPayoutService } from '../services/reward-payout.service';

export const REWARD_SIDE_EFFECT_CONSUMER = 'RewardSideEffectConsumer';

/**
 * `REWARD_GRANTED` -> the side effect the reward type promised.
 *
 * IT SUBSCRIBES TO `REWARD_GRANTED` AND NOTHING ELSE, and that is a security
 * property rather than a convenience. `REWARD_GRANTED` has exactly one producer
 * in the codebase — `RewardsCompletionConsumer`, inside its `if (granted > 0)`
 * — so there is no path from a duplicate or failed verification to a block of
 * screen time. The same wiring that guarantees "no grant ⇒ no notification"
 * guarantees "no grant ⇒ no minutes".
 *
 * FINDING THE LEDGER ROWS. The consumer does not receive them: it recomputes
 * the deterministic key prefix from the achievement's FROZEN
 * `applied_multiplier_bps` and looks them up. That is exactly why the multiplier
 * is frozen onto the row at verification time — a recomputed multiplier would
 * produce a different prefix here and the side effect would silently find
 * nothing.
 */
@Injectable()
export class RewardSideEffectConsumer implements OnModuleInit {
  private readonly logger = new Logger(RewardSideEffectConsumer.name);

  constructor(
    @Inject(EVENT_SUBSCRIBER) private readonly bus: IEventSubscriber,
    private readonly repo: PrismaRewardProgramRepository,
    private readonly payout: RewardPayoutService,
    private readonly outbox: OutboxWriter,
    private readonly idempotency: ConsumerIdempotency,
  ) {}

  onModuleInit(): void {
    this.bus.register('REWARD_GRANTED', REWARD_SIDE_EFFECT_CONSUMER, (envelope) =>
      this.handle(envelope),
    );
  }

  async handle(envelope: DomainEventEnvelope): Promise<void> {
    const payload = (envelope.payload ?? {}) as {
      childId?: string;
      completionKind?: string;
      sourceId?: string;
    };

    // Every other completion kind (habits, health, education) pays in XP/COINS
    // only and has no side effect to materialise.
    if (payload.completionKind !== 'ACHIEVEMENT') return;

    const childId = payload.childId ?? envelope.childId;
    const achievementId = payload.sourceId ?? envelope.aggregateId;
    if (!childId || !achievementId) return;

    await this.idempotency.once(REWARD_SIDE_EFFECT_CONSUMER, envelope.id, async () => {
      const achievement = await this.repo.findAchievement(achievementId);
      if (!achievement || achievement.status !== 'VERIFIED') return;

      const program = await this.repo.findProgram(achievement.programId);
      if (!program) return;

      // The frozen multiplier, read back — never recomputed. This reproduces
      // the ACHIEVEMENT_VERIFIED envelope key exactly, and `RewardsEngineService`
      // builds every ledger key as `${eventKey}:${rewardType}:${source}` — so
      // the event key IS the shared prefix of this grant's ledger rows.
      const prefix = achievementGrantKeyPrefix(
        childId,
        achievementId,
        achievement.appliedMultiplierBps ?? BASE_MULTIPLIER_BPS,
      );

      const entries = await this.repo.listLedgerEntriesByKeyPrefix(childId, prefix);
      if (entries.length === 0) {
        this.logger.warn(`reward.side_effect no ledger rows for achievement=${achievementId}`);
        return;
      }

      let grantedAmount = 0;
      for (const entry of entries) {
        grantedAmount += Number(entry.amount ?? 0);

        const result = await this.payout.payOut(
          achievement,
          program,
          { id: entry.id, rewardType: String(entry.rewardType), amount: Number(entry.amount) },
          new Date(),
        );
        if (result.kind !== 'NONE') {
          this.logger.log(
            `reward.side_effect kind=${result.kind} achievement=${achievementId} id=${result.id}`,
          );
        }

        // BADGE_EARNED is emitted ONLY here, i.e. only after a ledger row of
        // type BADGE really exists — which itself only happens after a real
        // `ChildBadgeAward` insert succeeded inside the untouched engine.
        if (String(entry.rewardType) === 'BADGE') {
          await this.outbox.write({
            type: 'BADGE_EARNED',
            aggregateType: 'ChildBadgeAward',
            aggregateId: entry.id,
            childId,
            deviceId: null,
            idempotencyKey: composeIdempotencyKey('BADGE_EARNED', { childId, sourceId: entry.id }),
            clientEventId: null,
            occurredAt: new Date(),
            traceId: envelope.traceId,
            payload: { childId, ledgerEntryId: entry.id, achievementId },
          });
        }
      }

      // Audit convenience only. The ledger remains the source of truth; this
      // column exists so a parent's achievement list does not need a join.
      await this.repo.updateAchievement(achievementId, { grantedAmount });
    });
  }
}
