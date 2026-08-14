import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { tenantIdForWrite } from '../../../common/tenancy/tenant-context';
import type { DomainEventDraft, WriteEventOutcome } from '../domain/outbox.types';

/**
 * Minimal structural type for "a Prisma client or a Prisma transaction client".
 * Typed structurally on purpose: the application injects the EXTENDED client
 * (a Proxy), and the tenancy proof suites inject a WASM-engine client. Naming
 * a generated Prisma type here would bind this file to one of the two.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface PrismaLike {
  domainEvent: any;
  outboxMessage: any;
  consumedMessage: any;
  habitCompletion: any;
  $transaction: <T>(fn: (tx: PrismaLike) => Promise<T>) => Promise<T>;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * THE OUTBOX WRITE. The only sanctioned way a domain event enters the system.
 *
 * The contract it enforces, and the reason the pattern exists at all
 * (docs/04 §5.4): the event row and the domain state change commit TOGETHER or
 * not at all. Publishing directly — `await fcm.send()` before the COMMIT —
 * produces the failure that section names explicitly: "the child sees +20
 * points and their balance never moved".
 *
 * `writeWithin(tx, draft)` therefore takes the caller's transaction client. It
 * does not open its own, and it must not: opening its own would put the event
 * OUTSIDE the caller's transaction, which is the entire bug this class exists
 * to prevent.
 *
 * DUPLICATES ARE NOT ERRORS. `INSERT ... ON CONFLICT DO NOTHING` semantics are
 * modelled with a caught P2002: `created: false` means "this exact real-world
 * occurrence is already recorded", which the ingestion endpoint reports to the
 * device as `DUPLICATE` — a success, per docs/06 §6.4.
 */
@Injectable()
export class OutboxWriter {
  private readonly logger = new Logger(OutboxWriter.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Writes `domain_events` + `outbox_messages` on the CALLER'S transaction.
   * `familyId` is taken from the ambient tenant context, never from the draft —
   * there is no parameter for it, so there is no call site that can get it
   * wrong.
   */
  async writeWithin(tx: PrismaLike, draft: DomainEventDraft): Promise<WriteEventOutcome> {
    const familyId = tenantIdForWrite();

    try {
      const event = await tx.domainEvent.create({
        data: {
          familyId,
          childId: draft.childId,
          deviceId: draft.deviceId,
          aggregateType: draft.aggregateType,
          aggregateId: draft.aggregateId,
          eventType: draft.type,
          idempotencyKey: draft.idempotencyKey,
          clientEventId: draft.clientEventId,
          schemaVersion: draft.schemaVersion ?? 1,
          payload: draft.payload,
          correlationId: draft.traceId,
          occurredAt: draft.occurredAt,
        },
        select: { id: true },
      });

      await tx.outboxMessage.create({
        data: {
          familyId,
          domainEventId: event.id,
          eventType: draft.type,
          destination: 'INTERNAL_BUS',
          payload: draft.payload,
        },
        select: { id: true },
      });

      return { created: true, domainEventId: event.id };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // A real, previously-recorded occurrence. Neither row is written, and
      // nothing downstream runs — which is exactly the point: the second
      // delivery of the same habit completion must not enqueue a second
      // reward evaluation.
      this.logger.debug(
        `outbox.duplicate type=${draft.type} key=${draft.idempotencyKey} — no new event, no new message.`,
      );
      return { created: false, domainEventId: null };
    }
  }

  /**
   * For producers that have no surrounding transaction of their own — a
   * consumer emitting a DERIVED event (`REWARD_GRANTED`, `STREAK_ACHIEVED`).
   * It opens a transaction so the event row and its outbox row still commit
   * atomically with each other.
   */
  async write(draft: DomainEventDraft): Promise<WriteEventOutcome> {
    return (this.prisma as unknown as PrismaLike).$transaction((tx) => this.writeWithin(tx, draft));
  }
}

/** Prisma's unique-constraint error, without importing the generated namespace. */
export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === 'P2002'
  );
}
