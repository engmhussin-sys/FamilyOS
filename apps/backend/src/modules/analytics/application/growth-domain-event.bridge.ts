import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { EVENT_SUBSCRIBER, type IEventSubscriber } from '../../events/domain/event-bus.port';
import { COMPLETION_EVENT_TYPES } from '../../../shared/events/event-types';
import { isCompletionEventPayload, type CompletionEvent } from '../../../shared/events/completion-event';
import type { DomainEventEnvelope } from '../../../shared/events/event-envelope';
import { ActivationService } from './activation.service';
import { GrowthEventEmitter } from './growth-event-emitter.service';

export const GROWTH_DOMAIN_EVENT_BRIDGE = 'GrowthDomainEventBridge';

/** The `REWARD_GRANTED` payload, as `RewardsCompletionConsumer` writes it. */
interface IRewardGrantedPayload {
  readonly childId?: unknown;
  readonly grantCount?: unknown;
  readonly completionKind?: unknown;
}

/**
 * PHASE D (GROWTH) — WHERE THE DOMAIN BUS FEEDS THE GROWTH FUNNEL.
 *
 * FIVE OF THE NINETEEN GROWTH EVENTS ARE PROJECTIONS OF SIGNALS THAT ALREADY
 * EXISTED (`DEVICE_PAIRED`, `GOAL_STARTED`, `GOAL_COMPLETED`, `REWARD_GRANTED`,
 * and the activation event derived from the last of them). Re-instrumenting
 * their producers would have meant a second call site next to every existing
 * `outbox.write` — nine of them for completions alone — each of which could be
 * forgotten, and each of which would fire even when the domain write was later
 * rolled back.
 *
 * Subscribing to the bus instead gives three properties for free:
 *   1. A growth event exists only if the domain event was actually PUBLISHED,
 *      i.e. only if the transaction that caused it committed. No phantom
 *      funnel steps from rolled-back work.
 *   2. Every producer is covered without any producer being edited. Adding a
 *      tenth completion type to `COMPLETION_EVENT_TYPES` instruments it here
 *      automatically, exactly as it already wires it to the reward engine.
 *   3. The tenant is already established: the relay re-enters
 *      `runWithTenant({ familyId })` before invoking a handler, so every read
 *      this bridge performs is scoped by the extension.
 *
 * IT NEVER THROWS. A handler that throws marks the outbox message FAILED and
 * sends it to the retry/dead-letter path — which for `REWARD_GRANTED` would
 * mean an analytics hiccup delaying a parent's notification about a reward
 * their child earned. Analytics is not permitted to do that. Every failure is
 * caught and logged here, and this is the one consumer in the codebase for
 * which that is the right choice, stated so nobody copies it into one where it
 * is not.
 *
 * IT DOES NOT USE `ConsumerIdempotency`, ON PURPOSE — and PHASE F (`F6-004`,
 * closing `PF-E-004`) KEPT THAT CHOICE WHILE FIXING WHAT IT COST.
 *
 * The paragraph that used to sit here said «double-counting an analytics event
 * is a rounding error». `e2e-01 › THE REPLAY` measured the rounding error: two
 * redeliveries with the consumer markers deleted produced THREE
 * `analytics_events(REWARD_GRANTED)` rows beside one ledger row, one timeline
 * entry, one notification and one activation. The FIRST_REWARD funnel step and
 * every conversion rate derived from it were inflated by the redelivery rate —
 * a number nobody had, on a chart the business reads.
 *
 * THE FIX IS NOT `ConsumerIdempotency`, and the reason is the same one B9 gave
 * about notifications: F3's own docstring calls `consumed_messages` an
 * OPTIMISATION, and the scenario that measured this defect DELETES that marker
 * in order to force the replay. A marker-based fix would pass a test nobody
 * wrote and fail the one that exists.
 *
 * So every event this bridge emits now carries `sourceEventId = envelope.id` —
 * `domain_events.id`, server-assigned and IDENTICAL on every redelivery for as
 * long as the row exists — and `analytics_events (event_name, source_event_id)`
 * refuses the second row (migration 0020). The refusal is a CONSTRAINT, not a
 * window and not something that can be dropped while the cause survives.
 *
 * WHAT DID NOT CHANGE: this bridge still writes no marker, still never throws,
 * and the activation is still protected by its own UNIQUE index on the row —
 * two independent guarantees rather than one shared one.
 */
@Injectable()
export class GrowthDomainEventBridge implements OnModuleInit {
  private readonly logger = new Logger(GrowthDomainEventBridge.name);

  constructor(
    @Inject(EVENT_SUBSCRIBER) private readonly bus: IEventSubscriber,
    private readonly growthEvents: GrowthEventEmitter,
    private readonly activation: ActivationService,
  ) {}

  onModuleInit(): void {
    for (const type of COMPLETION_EVENT_TYPES) {
      this.bus.register(type, GROWTH_DOMAIN_EVENT_BRIDGE, (envelope) => this.onCompletion(envelope));
    }
    this.bus.register('REWARD_GRANTED', GROWTH_DOMAIN_EVENT_BRIDGE, (e) => this.onRewardGranted(e));
    this.bus.register('DEVICE_PAIRED', GROWTH_DOMAIN_EVENT_BRIDGE, (e) => this.onDevicePaired(e));
    this.bus.register('ACHIEVEMENT_REQUESTED', GROWTH_DOMAIN_EVENT_BRIDGE, (e) => this.onGoalStarted(e));
    this.bus.register('REWARD_PROGRAM_CREATED', GROWTH_DOMAIN_EVENT_BRIDGE, (e) => this.onGoalCreated(e));
  }

  private async onCompletion(envelope: DomainEventEnvelope): Promise<void> {
    await this.guard('GOAL_COMPLETED', async () => {
      const completionKind = isCompletionEventPayload(envelope.payload)
        ? (envelope.payload as CompletionEvent).completionKind
        : undefined;

      await this.growthEvents.emit({
        name: 'GOAL_COMPLETED',
        familyId: envelope.familyId,
        sessionId: `bus:${envelope.familyId}`,
        payload: { completionKind, goalKind: envelope.type },
        sourceEventId: envelope.id,
      });
    });
  }

  private async onRewardGranted(envelope: DomainEventEnvelope): Promise<void> {
    await this.guard('REWARD_GRANTED', async () => {
      const payload = (envelope.payload ?? {}) as IRewardGrantedPayload;
      const grantCount = typeof payload.grantCount === 'number' ? payload.grantCount : 0;
      const completionKind = typeof payload.completionKind === 'string' ? payload.completionKind : undefined;

      await this.growthEvents.emit({
        name: 'REWARD_GRANTED',
        familyId: envelope.familyId,
        sessionId: `bus:${envelope.familyId}`,
        payload: { grantCount, completionKind },
        sourceEventId: envelope.id,
      });

      // THE ACTIVATION EVALUATION. Everything the four gates need is already
      // on this envelope except the two creation timestamps, which the service
      // reads under the tenant the relay established.
      const childId = typeof payload.childId === 'string' ? payload.childId : null;
      if (!childId || !completionKind) return;

      await this.activation.evaluate({
        familyId: envelope.familyId,
        childId,
        completionKind: completionKind as CompletionEvent['completionKind'],
        grantCount,
        occurredAt: new Date(envelope.occurredAt),
      });
    });
  }

  private async onDevicePaired(envelope: DomainEventEnvelope): Promise<void> {
    await this.guard('DEVICE_PAIRED', () =>
      this.growthEvents.emit({
        name: 'DEVICE_PAIRED',
        familyId: envelope.familyId,
        sessionId: `bus:${envelope.familyId}`,
        sourceEventId: envelope.id,
      }),
    );
  }

  private async onGoalStarted(envelope: DomainEventEnvelope): Promise<void> {
    await this.guard('GOAL_STARTED', () =>
      this.growthEvents.emit({
        name: 'GOAL_STARTED',
        familyId: envelope.familyId,
        sessionId: `bus:${envelope.familyId}`,
        payload: { goalKind: envelope.aggregateType },
        sourceEventId: envelope.id,
      }),
    );
  }

  private async onGoalCreated(envelope: DomainEventEnvelope): Promise<void> {
    await this.guard('GOAL_CREATED', () =>
      this.growthEvents.emit({
        name: 'GOAL_CREATED',
        familyId: envelope.familyId,
        sessionId: `bus:${envelope.familyId}`,
        payload: { goalKind: envelope.aggregateType },
        sourceEventId: envelope.id,
      }),
    );
  }

  /** See the class docstring: analytics never fails a domain message. */
  private async guard(label: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.logger.warn(
        `growth.bridge_failed event=${label} — the domain message is unaffected. ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
