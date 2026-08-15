import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { RewardsEngineService } from '../../../life-intelligence/application/services/rewards-engine.service';
import {
  COMPLETION_KIND_TO_REWARD_ENGINE,
  isCompletionEventPayload,
  type CompletionEvent,
} from '../../../../shared/events/completion-event';
import { COMPLETION_EVENT_TYPES } from '../../../../shared/events/event-types';
import { composeRewardGrantedKey } from '../../../../shared/events/idempotency';
import type { DomainEventEnvelope } from '../../../../shared/events/event-envelope';
import { EVENT_SUBSCRIBER, type IEventSubscriber } from '../../domain/event-bus.port';
import { ConsumerIdempotency } from './consumer-idempotency.service';
import { OutboxWriter } from '../outbox.writer';

export const REWARDS_COMPLETION_CONSUMER = 'RewardsCompletionConsumer';

/**
 * THE ONE COMPLETION PATH (CONTEXT §3 principle 1, gate G5).
 *
 * Read the `register` loop below: this consumer subscribes to
 * `COMPLETION_EVENT_TYPES` — all eight of them — with the SAME handler. Habits,
 * Tasks, Health and Education/Faith do not each get a branch here, and there is
 * no `switch (source)`. The only thing the handler reads to decide which Reward
 * Rules apply is `payload.completionKind`, and it uses it as a table lookup, not
 * as a conditional.
 *
 * That is what "do not build four parallel completion engines" means in
 * practice: adding Tasks tomorrow is one entry in
 * `COMPLETION_KIND_TO_REWARD_ENGINE` and zero lines in this file.
 *
 * THE RULE THAT MATTERS MOST (CONTEXT §5, brief §46):
 *   if no reward was actually granted, NO `REWARD_GRANTED` event is emitted.
 * It is not a check somewhere further down — it is the `if (granted > 0)` that
 * the outbox write sits inside. There is no other producer of `REWARD_GRANTED`
 * in the codebase, so there is no path by which a duplicate completion can
 * reach the Notification Engine at all. `RewardsEngineService.processTriggerEvent`
 * returns the count of grants the DATABASE actually created (its ledger insert
 * is `ON CONFLICT DO NOTHING` and it returns `false` when zero rows were
 * written), so "granted" here means "PostgreSQL created a row", not "the code
 * believed it should".
 */
@Injectable()
export class RewardsCompletionConsumer implements OnModuleInit {
  private readonly logger = new Logger(RewardsCompletionConsumer.name);

  constructor(
    @Inject(EVENT_SUBSCRIBER) private readonly bus: IEventSubscriber,
    private readonly rewards: RewardsEngineService,
    private readonly outbox: OutboxWriter,
    private readonly idempotency: ConsumerIdempotency,
  ) {}

  onModuleInit(): void {
    for (const type of COMPLETION_EVENT_TYPES) {
      this.bus.register(type, REWARDS_COMPLETION_CONSUMER, (envelope) => this.handle(envelope));
    }
  }

  async handle(envelope: DomainEventEnvelope): Promise<void> {
    const payload = envelope.payload;
    if (!isCompletionEventPayload(payload)) {
      // A completion-typed event whose payload is not a CompletionEvent is a
      // contract violation by its producer. Throwing routes it to the outbox's
      // retry/dead-letter path rather than silently dropping a reward.
      throw new Error(
        `${envelope.type} ${envelope.id} does not carry a CompletionEvent payload — contract violation.`,
      );
    }

    await this.idempotency.once(REWARDS_COMPLETION_CONSUMER, envelope.id, async () => {
      const completion = payload as CompletionEvent;
      const engine = COMPLETION_KIND_TO_REWARD_ENGINE[completion.completionKind];
      if (!engine) {
        throw new Error(`Unmapped completionKind "${completion.completionKind}".`);
      }

      const granted = await this.rewards.processTriggerEvent(completion.childId, envelope.familyId, {
        engine,
        type: envelope.type,
        // The Rewards Engine sees the CompletionEvent and nothing else. It does
        // not receive, and cannot read, which module produced it — gate G5.
        payload: { ...completion },
        // The database-level idempotency key. This is what makes a redelivered
        // message grant zero additional rewards.
        idempotencyKey: envelope.idempotencyKey,
        // B4 — THE ONLY PLACE THIS IS SET. A grant made here is announced by
        // the `REWARD_GRANTED` outbox message written below, which
        // `NotificationRewardConsumer` turns into exactly one notification. The
        // engine must therefore NOT notify again, or one completion through
        // this pipeline would produce two. The direct `/self/*` callers leave
        // it unset and the engine notifies for them, because nothing else will.
        announcedViaOutbox: true,
      });

      if (granted === 0) {
        // THE RULE. Duplicate or no matching rule => stop here. No event, no
        // notification, nothing.
        this.logger.debug(
          `rewards.no_grant type=${envelope.type} eventId=${envelope.id} — no REWARD_GRANTED emitted.`,
        );
        return;
      }

      const account = await this.rewards.getAccount(completion.childId, envelope.familyId);

      await this.outbox.write({
        type: 'REWARD_GRANTED',
        aggregateType: 'RewardGrant',
        aggregateId: envelope.aggregateId,
        childId: completion.childId,
        deviceId: envelope.deviceId,
        // Derived deterministically from the ORIGINATING event's key, so a
        // redelivery that somehow got past the ledger would still collide here.
        idempotencyKey: composeRewardGrantedKey(envelope.idempotencyKey),
        clientEventId: null,
        occurredAt: new Date(),
        traceId: envelope.traceId,
        payload: {
          childId: completion.childId,
          grantCount: granted,
          sourceType: envelope.aggregateType,
          sourceId: envelope.aggregateId,
          sourceEventType: envelope.type,
          completionKind: completion.completionKind,
          newBalance: { xp: account.xp, coins: account.coins, stars: account.stars, level: account.level },
        },
      });
    });
  }
}
