import { Injectable, Logger } from '@nestjs/common';

import type { DomainEventEnvelope } from '../../../shared/events/event-envelope';
import type { DomainEventType } from '../../../shared/events/event-types';
import type {
  DomainEventHandler,
  HandlerFailure,
  IEventPublisher,
  IEventSubscriber,
  PublishResult,
} from '../domain/event-bus.port';

interface Registration {
  readonly type: DomainEventType;
  readonly consumerName: string;
  readonly handler: DomainEventHandler<never>;
}

/**
 * The in-process bus. ~60 lines, because that is genuinely all an in-process
 * bus is once the durability lives in the outbox instead of the bus.
 *
 * ORDERING, STATED HONESTLY:
 *  - Handlers for ONE event run SEQUENTIALLY, in registration order. That is a
 *    guarantee, and consumers may rely on it.
 *  - Events do NOT have a global order. The relay claims a batch with
 *    `FOR UPDATE SKIP LOCKED` and multiple relay instances may run; two events
 *    for the same child can be delivered out of order. Every consumer must
 *    therefore be commutative or idempotent, which they are: Rewards is keyed
 *    on `idempotencyKey`, Notifications is keyed on type + a 5-minute duplicate
 *    window, and Streaks recomputes from the completion rows rather than
 *    incrementing a counter.
 *  - Per-aggregate ordering is available later without changing this file:
 *    partition the relay's claim query by `aggregate_id % N`. It is not built
 *    now because nothing today needs it, and claiming ordering that has not
 *    been tested is worse than admitting there is none.
 *
 * ISOLATION: one throwing handler does NOT stop the others. All failures are
 * collected and returned, so a single broken consumer retries its own message
 * without blocking the queue for every other consumer.
 */
@Injectable()
export class InProcessEventBus implements IEventPublisher, IEventSubscriber {
  private readonly logger = new Logger(InProcessEventBus.name);
  private readonly handlers = new Map<DomainEventType, Registration[]>();

  register<TPayload>(
    type: DomainEventType,
    consumerName: string,
    handler: DomainEventHandler<TPayload>,
  ): void {
    const list = this.handlers.get(type) ?? [];
    if (list.some((r) => r.consumerName === consumerName)) {
      // Registering the same consumer twice for the same type would double
      // every side effect. Loud, not silent: a duplicate registration is a
      // wiring bug, and it is cheap to catch at boot instead of in production.
      throw new Error(
        `Consumer "${consumerName}" is already registered for ${type}. ` +
          'A duplicate registration would deliver the same event to it twice.',
      );
    }
    list.push({ type, consumerName, handler: handler as DomainEventHandler<never> });
    this.handlers.set(type, list);
  }

  registrations(): ReadonlyArray<{ type: DomainEventType; consumerName: string }> {
    return [...this.handlers.values()]
      .flat()
      .map((r) => ({ type: r.type, consumerName: r.consumerName }));
  }

  async publish(envelope: DomainEventEnvelope): Promise<PublishResult> {
    const registered = this.handlers.get(envelope.type) ?? [];
    const failures: HandlerFailure[] = [];

    for (const registration of registered) {
      try {
        await (registration.handler as DomainEventHandler)(envelope);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        // No payload in the log line: CONTEXT §3 principle 8 (child data never
        // reaches logs). Type, ids and the message only.
        this.logger.warn(
          `consumer.failed consumer=${registration.consumerName} type=${envelope.type} ` +
            `eventId=${envelope.id} error=${error.message}`,
        );
        failures.push({ consumerName: registration.consumerName, error });
      }
    }

    return { handlersInvoked: registered.length, failures };
  }
}
