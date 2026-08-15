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
 * There is no other producer of `REWARD_GRANTED` in the codebase, so there is
 * no path by which an unpaid completion can reach the Notification Engine at
 * all.
 *
 * PHASE C (`PC-B-001`) — HOW THAT RULE IS NOW DECIDED, AND WHY IT CHANGED.
 * The rule used to be expressed as `if (granted > 0)`, where `granted` is what
 * `processTriggerEvent` returns: the number of ledger rows THIS ATTEMPT
 * created. That is not the same question as "was this business event paid?",
 * and `PA-B-009` is the price of the difference — see the comment at the branch
 * itself. The rule is now decided against the LEDGER, which is the only
 * authority on whether a reward exists, and the branch below states exactly how.
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

      /**
       * PHASE C (`PC-B-001`, closing `PA-B-009`) — THE LINE THAT LOST THE
       * REWARD, AND WHAT REPLACES IT.
       *
       * WHAT WAS HERE: `if (granted === 0) return;`. The comment above it was
       * right about the rule and wrong about the variable. `granted` counts the
       * rows THIS ATTEMPT created, not the rows that exist; the ledger insert is
       * `ON CONFLICT DO NOTHING`, so a RETRY of a message whose grant already
       * committed sees 0 and returned here — permanently, and then the relay
       * marked the message PUBLISHED. The reward was in the ledger, the
       * `REWARD_GRANTED` event did not exist, and the parent was never told.
       * `test/events/reward-delivery-recovery.e2e.spec.ts` reproduces exactly
       * that: `{rewards: 1, timeline: 1, events: 0, notifications: 0}`, forever.
       *
       * THE FIX IS TO ASK A DURABLE QUESTION. `granted > 0` still means "new
       * grants, announce them". `granted === 0` is now AMBIGUOUS and is
       * resolved against the ledger: zero recorded grants means the rule
       * genuinely did not match (THE RULE, unchanged — no grant, no event, no
       * notification); a non-zero count means this business event WAS paid and
       * its announcement is still owed.
       *
       * WHY RE-EMITTING CANNOT DUPLICATE ANYTHING. The announcement's key is
       * `composeRewardGrantedKey(envelope.idempotencyKey)` — derived, stable
       * across every redelivery — so a second write collides on
       * `domain_events (family_id, idempotency_key)` and `OutboxWriter.write`
       * returns `created: false` without a second row. The notification is keyed
       * on `domain_events.id`, which is the SAME id, so B9's
       * `notifications (family_id, source_event_id, user_id)` refuses a second
       * one. The invariant ONE BUSINESS EVENT -> ONE REWARD -> ONE TIMELINE
       * ENTRY -> ONE NOTIFICATION is preserved by two database constraints, not
       * by this branch.
       *
       * THE EXTRA READ COSTS ONE COUNT, AND ONLY ON THE ZERO PATH. The happy
       * path — `granted > 0` — does not execute it at all.
       */
      const recorded =
        granted > 0
          ? granted
          : await this.rewards.countGrantsFor(
              completion.childId,
              envelope.familyId,
              envelope.idempotencyKey,
            );

      if (recorded === 0) {
        // THE RULE. No matching rule => stop here. No event, no notification,
        // nothing. Now proven against the ledger rather than assumed from a
        // per-attempt counter.
        this.logger.debug(
          `rewards.no_grant type=${envelope.type} eventId=${envelope.id} — no REWARD_GRANTED emitted.`,
        );
        return;
      }

      if (granted === 0) {
        // The recovery path, logged LOUDLY. Reaching it means a previous
        // attempt granted and then failed before announcing — the `PA-B-009`
        // window really opened in production, and an operator should see that
        // it did even though the system healed itself.
        this.logger.warn(
          `rewards.announcement_recovered type=${envelope.type} eventId=${envelope.id} ` +
            `grants=${recorded} — a prior attempt granted without announcing; re-emitting REWARD_GRANTED.`,
        );
      }

      /**
       * PHASE C (`PC-B-006`) — THE TIMELINE ENTRY, MADE AS DURABLE AS THE
       * REWARD IT DESCRIBES.
       *
       * `announceGrant` writes this entry inside `processTriggerEvent`, and it
       * SWALLOWS a failure — correctly, because a timeline write must never
       * unwind a committed grant. But `announceGrant` is only reached when new
       * grants were created, so on a redelivery it is never called: the one
       * place that writes the entry was exactly the place a retry could not
       * reach, and a moment lost to a transient blip was lost forever while the
       * outbox reported success. That is `PA-B-009`'s shape, one table over.
       *
       * This call is the repair, and it is NOT wrapped in a try/catch: the
       * relay retries this consumer, so letting the error propagate is what
       * turns «lost» into «retried». It is safe to run on EVERY delivery
       * because the write is keyed and
       * `life_timeline_events_reward_source_key_uq` (migration 0010) refuses
       * the second one — the repository reports the existing row rather than
       * throwing, so the ordinary path pays one refused INSERT and nothing else.
       *
       * BEFORE the outbox write, deliberately. If the entry cannot be written
       * we want the message to retry with NO `REWARD_GRANTED` yet emitted,
       * rather than to notify a parent about a reward that is missing from the
       * timeline the notification tells them to go and look at.
       */
      await this.rewards.ensureGrantTimeline(
        completion.childId,
        envelope.familyId,
        { engine, type: envelope.type, payload: { ...completion }, idempotencyKey: envelope.idempotencyKey },
        recorded,
      );

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
          // `recorded`, not `granted`: on the recovery path `granted` is 0 and
          // announcing "0 grants" for a reward that exists would be a lie in
          // the one payload a parent-facing screen reads.
          grantCount: recorded,
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
