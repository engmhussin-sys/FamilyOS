import type { DomainEventEnvelope } from '../../../shared/events/event-envelope';
import type { DomainEventType } from '../../../shared/events/event-types';

/**
 * THE ONE SEAM. Everything above this interface (the relay, the consumers)
 * and everything below it (the actual transport) are independent.
 *
 * WHY A HAND-ROLLED TYPED BUS AND NOT `@nestjs/event-emitter`:
 *
 *  1. It is not in `package.json`. The brief says prefer what is already
 *     there; `@nestjs/event-emitter` would be a new production dependency
 *     bought for `EventEmitter2`, whose entire contribution is a `Map` of
 *     arrays and a wildcard matcher we do not want (a wildcard subscription is
 *     how a consumer accidentally starts receiving `IMPORTANT_SAFETY_EVENT`).
 *  2. TYPES. `EventEmitter2.emit(name: string, ...values: any[])` erases the
 *     payload. `IEventSubscriber.register('HABIT_COMPLETED', h)` narrows `h`'s
 *     argument to the HABIT_COMPLETED envelope at compile time. Since the whole
 *     point of this sprint is a typed contract, a bus that discards the type is
 *     the wrong tool.
 *  3. ERROR SEMANTICS. `EventEmitter2` swallows async handler rejections unless
 *     you opt in. The relay MUST know whether every handler succeeded, because
 *     that is what decides PUBLISHED vs FAILED-with-backoff. A bus that cannot
 *     tell you "handler 2 of 3 threw" cannot drive an outbox.
 *
 * THE ONE-FILE SWAP PATH TO REDIS STREAMS / SQS:
 *
 *   write `infrastructure/redis-streams-event-bus.ts` implementing this
 *   interface, then change the single `useClass` in `events.module.ts`.
 *
 * Nothing else moves, because nothing else imports the implementation: the
 * relay depends on `EVENT_PUBLISHER`, consumers depend on `EVENT_SUBSCRIBER`,
 * and both are tokens. The distributed version's `publish()` does an XADD and
 * returns immediately; `register()` becomes a consumer-group subscription. The
 * outbox does not change at all — it is already the durable hand-off, which is
 * the property that makes the swap cheap.
 */

export const EVENT_PUBLISHER = Symbol('EVENT_PUBLISHER');
export const EVENT_SUBSCRIBER = Symbol('EVENT_SUBSCRIBER');

export type DomainEventHandler<TPayload = unknown> = (
  envelope: DomainEventEnvelope<TPayload>,
) => Promise<void>;

export interface HandlerFailure {
  readonly consumerName: string;
  readonly error: Error;
}

export interface PublishResult {
  /** How many registered handlers ran (successfully or not). */
  readonly handlersInvoked: number;
  /** Empty means every handler acked. Non-empty means the message is FAILED. */
  readonly failures: readonly HandlerFailure[];
}

export interface IEventPublisher {
  /**
   * Delivers to every handler registered for `envelope.type`.
   *
   * MUST NOT throw for a handler error — it reports failures in the result, so
   * the relay can distinguish "one consumer is down" (retry) from "the bus
   * itself is broken" (throw).
   */
  publish(envelope: DomainEventEnvelope): Promise<PublishResult>;
}

export interface IEventSubscriber {
  register<TPayload>(
    type: DomainEventType,
    consumerName: string,
    handler: DomainEventHandler<TPayload>,
  ): void;

  /** Introspection for the DI-graph test and the /system diagnostics surface. */
  registrations(): ReadonlyArray<{ type: DomainEventType; consumerName: string }>;
}
