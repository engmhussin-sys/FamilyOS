/* eslint-disable @typescript-eslint/no-explicit-any */
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { ConsumerIdempotency } from '../../../events/application/consumers/consumer-idempotency.service';
import { EVENT_SUBSCRIBER, type IEventSubscriber } from '../../../events/domain/event-bus.port';
import type { DomainEventEnvelope } from '../../../../shared/events/event-envelope';
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
    /**
     * NO `OutboxWriter`, DELIBERATELY. This consumer used to hold one for the
     * single purpose of emitting `BADGE_EARNED` — an event with no reader; see
     * the block in `handle` below. The dependency is removed with the emission
     * rather than left injected and unused, so nothing here can quietly grow a
     * second producer of an event this module does not own.
     */
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

        /**
         * =================================================================
         * THE `BADGE_EARNED` EMISSION THAT USED TO BE HERE IS GONE, AND THIS
         * COMMENT IS WHY IT MUST NOT COME BACK.
         * =================================================================
         *
         * WHAT WAS HERE. `if (String(entry.rewardType) === 'BADGE')` wrote a
         * `BADGE_EARNED` outbox message for every BADGE ledger row under a
         * verified achievement's key prefix. It was the ONLY producer of
         * `BADGE_EARNED` in the backend.
         *
         * IT HAD NO READER. `IEventSubscriber` is a typed, per-type registry
         * with NO WILDCARD (by design — see `event-bus.port.ts`), and nothing
         * anywhere called `register('BADGE_EARNED', …)`. The relay published
         * the message to zero handlers and marked it PUBLISHED. An event
         * nobody reads is indistinguishable from a working feature, which is
         * exactly how this survived review.
         *
         * IT WAS ALSO UNREACHABLE. Getting here needs a BADGE ledger row under
         * an ACHIEVEMENT's key prefix, which needs a `RewardRule` with
         * `eventType: 'ACHIEVEMENT_VERIFIED'` and `reward_type = 'BADGE'`. The
         * only BADGE rules that exist are the nine migration 0026 seeded from
         * `PLATFORM_BADGES`, not one of which names `ACHIEVEMENT_VERIFIED`;
         * and a program's own companion rules cannot pay BADGE at all
         * (`PROGRAM_REWARD_TYPES` has no such member and `CreateRewardRuleDto`
         * is `@IsIn(['XP','COINS'])`).
         *
         * ---------------------------------------------------------------
         * WHO OWNS THE BADGE ANNOUNCEMENT — `RewardsEngineService
         * .processTriggerEvent`, in its `if (granted)` branch, with TWO
         * `notifyGrant` calls: `BADGE_EARNED` for the child and
         * `BADGE_EARNED_PARENT` for the parent, issued SYNCHRONOUSLY on the
         * request that earned the badge, immediately after
         * `awardBadgeIfNotAlready` and `applyEarn` have BOTH succeeded.
         * ---------------------------------------------------------------
         *
         * SO A READER WOULD HAVE BEEN A SECOND ANNOUNCEMENT, NOT A MISSING
         * ONE. Both audiences already hold their row before this consumer ever
         * runs — proved on persisted rows by
         * `test/rewards/badge-chain.e2e.spec.ts` §4/§5 and by
         * `test/life-intelligence/health-goal-badge-doors.e2e.spec.ts` §1.
         * Giving this event a consumer would have produced TWO notifications
         * for ONE badge, so the honest resolution was to delete the producer
         * rather than to feed it.
         *
         * DO NOT RE-ADD IT.
         * `test/life-intelligence/badge-earned-dormant.guard.spec.ts` goes red
         * if this producer returns, if a reader appears, or if the real
         * announcement named above is ever removed.
         */
      }

      // Audit convenience only. The ledger remains the source of truth; this
      // column exists so a parent's achievement list does not need a join.
      await this.repo.updateAchievement(achievementId, { grantedAmount });
    });
  }
}
