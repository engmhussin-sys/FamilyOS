/* eslint-disable @typescript-eslint/no-explicit-any */
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { ConsumerIdempotency } from '../../../events/application/consumers/consumer-idempotency.service';
import { OutboxWriter } from '../../../events/application/outbox.writer';
import { EVENT_SUBSCRIBER, type IEventSubscriber } from '../../../events/domain/event-bus.port';
import type { DomainEventEnvelope } from '../../../../shared/events/event-envelope';
import { composeIdempotencyKey } from '../../../../shared/events/idempotency';
import { PrismaRewardProgramRepository } from '../../infrastructure/repositories/prisma-reward-program.repository';

export const ACHIEVEMENT_OUTCOME_CONSUMER = 'AchievementOutcomeConsumer';

/**
 * `ACHIEVEMENT_VERIFIED` -> the two ANNOUNCEMENT events the brief names:
 * `QURAN_ACHIEVEMENT_COMPLETED` for the Quran categories and
 * `LEARNING_GOAL_COMPLETED` for everything else.
 *
 * WHY NEITHER CARRIES A `CompletionEvent`, stated because it is the one thing
 * that could quietly double every reward in the system: `RewardsCompletionConsumer`
 * subscribes to `COMPLETION_EVENT_TYPES`. If either of these events joined that
 * set, ONE verified achievement would reach the Rewards Engine twice and pay
 * twice. They are announcements ABOUT a completion, and `carriesCompletionEvent:
 * false` in the catalogue is the machine-readable form of that sentence.
 *
 * It also writes the REUSE row: a verified achievement lands as a
 * `LearningSession`, so the existing Education/Faith reporting sees the work
 * without a second model being invented for it.
 */
@Injectable()
export class AchievementOutcomeConsumer implements OnModuleInit {
  private readonly logger = new Logger(AchievementOutcomeConsumer.name);

  constructor(
    @Inject(EVENT_SUBSCRIBER) private readonly bus: IEventSubscriber,
    private readonly repo: PrismaRewardProgramRepository,
    private readonly outbox: OutboxWriter,
    private readonly idempotency: ConsumerIdempotency,
  ) {}

  onModuleInit(): void {
    this.bus.register('ACHIEVEMENT_VERIFIED', ACHIEVEMENT_OUTCOME_CONSUMER, (envelope) =>
      this.handle(envelope),
    );
  }

  async handle(envelope: DomainEventEnvelope): Promise<void> {
    const payload = (envelope.payload ?? {}) as {
      childId?: string;
      sourceId?: string;
      programId?: string;
      localDate?: string;
      metadata?: Record<string, unknown>;
    };
    const childId = payload.childId ?? envelope.childId;
    const achievementId = payload.sourceId ?? envelope.aggregateId;
    if (!childId || !achievementId) return;

    await this.idempotency.once(ACHIEVEMENT_OUTCOME_CONSUMER, envelope.id, async () => {
      const program = payload.programId ? await this.repo.findProgram(payload.programId) : null;
      const category = String(program?.category ?? payload.metadata?.category ?? '');
      const isQuran = category === 'QURAN' || category === 'HADITH';

      const type = isQuran ? 'QURAN_ACHIEVEMENT_COMPLETED' : 'LEARNING_GOAL_COMPLETED';
      const idempotencyKey = composeIdempotencyKey(type, { childId, sourceId: achievementId });

      await this.outbox.write({
        type,
        aggregateType: 'AchievementRequest',
        aggregateId: achievementId,
        childId,
        deviceId: null,
        idempotencyKey,
        clientEventId: null,
        occurredAt: new Date(envelope.occurredAt),
        traceId: envelope.traceId,
        payload: {
          childId,
          achievementId,
          programId: payload.programId ?? null,
          category,
          activity: program?.activity ?? null,
          targetSummaryAr: program?.targetSummaryAr ?? null,
          localDate: payload.localDate ?? null,
        },
      });

      // REUSE, not a new model: the existing learning history sees this work.
      if (program) {
        try {
          await this.repo.createLearningSession({
            childId,
            subject: category,
            durationMinutes: program.durationMinutes,
            notes: program.targetSummaryAr,
          });
        } catch (err) {
          // Best-effort reporting row. It must never be able to fail a
          // verification that already happened and was already paid.
          this.logger.warn(
            `learning_session.write_failed achievement=${achievementId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }

      this.logger.debug(`achievement.outcome emitted=${type} achievement=${achievementId}`);
    });
  }
}
