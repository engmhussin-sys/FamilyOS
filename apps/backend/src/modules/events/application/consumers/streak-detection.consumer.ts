import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { HabitEngineService } from '../../../life-intelligence/application/services/habit-engine.service';
import type { CompletionEvent } from '../../../../shared/events/completion-event';
import { isCompletionEventPayload } from '../../../../shared/events/completion-event';
import { composeIdempotencyKey } from '../../../../shared/events/idempotency';
import type { DomainEventEnvelope } from '../../../../shared/events/event-envelope';
import { EVENT_SUBSCRIBER, type IEventSubscriber } from '../../domain/event-bus.port';
import { ConsumerIdempotency } from './consumer-idempotency.service';
import { OutboxWriter } from '../outbox.writer';

export const STREAK_DETECTION_CONSUMER = 'StreakDetectionConsumer';

/**
 * The milestones `HabitEngineService.completeHabit` already uses. Duplicated as
 * a constant rather than exported from that service on purpose: exporting it
 * would mean editing a frozen engine, and the brief asks for the minimum change
 * to existing code. If they ever diverge the streak consumer simply celebrates
 * different numbers than the in-app path — no correctness consequence.
 */
const STREAK_MILESTONES = [3, 7, 14, 30, 60, 100];

/**
 * Streaks, wired as a CONSUMER.
 *
 * It does NOT contain a streak algorithm. It calls
 * `HabitEngineService.getScoreBreakdown`, which already computes the current
 * streak with `computeCurrentStreak` over the child's real completion rows —
 * the same function `completeHabit` uses. That is the whole reason this file is
 * 90 lines and not 300: the calculator existed, it just had no event to react
 * to.
 *
 * WHY IT RECOMPUTES INSTEAD OF INCREMENTING: at-least-once delivery makes a
 * counter wrong the first time a message is redelivered. Recomputation from the
 * completion rows is naturally idempotent — the same input rows always produce
 * the same streak length — so a redelivered HABIT_COMPLETED yields the same
 * `STREAK_ACHIEVED` idempotency key and the outbox absorbs it.
 *
 * `STREAK_ACHIEVED` is a `CompletionEvent` with `completionKind: 'STREAK'`, so
 * it flows to the Rewards Engine through the same single path as every other
 * completion. There is no separate "streak reward" mechanism.
 */
@Injectable()
export class StreakDetectionConsumer implements OnModuleInit {
  private readonly logger = new Logger(StreakDetectionConsumer.name);

  constructor(
    @Inject(EVENT_SUBSCRIBER) private readonly bus: IEventSubscriber,
    private readonly habits: HabitEngineService,
    private readonly outbox: OutboxWriter,
    private readonly idempotency: ConsumerIdempotency,
  ) {}

  onModuleInit(): void {
    this.bus.register('HABIT_COMPLETED', STREAK_DETECTION_CONSUMER, (envelope) =>
      this.handle(envelope),
    );
  }

  async handle(envelope: DomainEventEnvelope): Promise<void> {
    if (!isCompletionEventPayload(envelope.payload)) return;
    const completion = envelope.payload as CompletionEvent;

    await this.idempotency.once(STREAK_DETECTION_CONSUMER, envelope.id, async () => {
      const breakdown = await this.habits.getScoreBreakdown(completion.childId, envelope.familyId);
      const streakDays = breakdown.streakDays;

      if (!STREAK_MILESTONES.includes(streakDays)) return;

      const idempotencyKey = composeIdempotencyKey('STREAK_ACHIEVED', {
        childId: completion.childId,
        kind: 'habits',
        milestone: streakDays,
      });

      const streakPayload: CompletionEvent = {
        schemaVersion: 1,
        completionKind: 'STREAK',
        childId: completion.childId,
        deviceId: envelope.deviceId,
        sourceType: 'StreakMilestone',
        sourceId: envelope.aggregateId,
        localDate: completion.localDate,
        occurredAt: envelope.occurredAt,
        idempotencyKey,
        pointsHint: null,
        verifiedBy: 'SYSTEM',
        metadata: { streakType: 'habits', streakDays },
      };

      const outcome = await this.outbox.write({
        type: 'STREAK_ACHIEVED',
        aggregateType: 'StreakMilestone',
        aggregateId: envelope.aggregateId,
        childId: completion.childId,
        deviceId: envelope.deviceId,
        idempotencyKey,
        clientEventId: null,
        occurredAt: new Date(envelope.occurredAt),
        traceId: envelope.traceId,
        payload: { ...streakPayload },
      });

      this.logger.debug(
        `streak.milestone childId=${completion.childId.slice(0, 8)} days=${streakDays} ` +
          `emitted=${outcome.created}`,
      );
    });
  }
}
