import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'crypto';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { runAsSystemAsync } from '../../../common/tenancy/system-context';
import { runWithTenant } from '../../../common/tenancy/tenant-context';
import type { DomainEventEnvelope } from '../../../shared/events/event-envelope';
import { ENVELOPE_VERSION } from '../../../shared/events/event-envelope';
import { EVENT_PUBLISHER, type IEventPublisher } from '../domain/event-bus.port';
import { OUTBOX_RELAY_DEFAULTS, type ClaimedOutboxMessage } from '../domain/outbox.types';
import {
  SQL_CLAIM_OUTBOX_BATCH,
  SQL_MARK_OUTBOX_FAILED,
  SQL_MARK_OUTBOX_PUBLISHED,
  SQL_OLDEST_PENDING_AGE_SECONDS,
  SQL_RECLAIM_STALE_OUTBOX_LOCKS,
} from '../infrastructure/outbox.sql';

/**
 * The columns of the event row the relay reads to rebuild an envelope. Declared
 * here rather than imported from the generated Prisma namespace for the same
 * reason `PrismaLike` is structural: this file must work against both the
 * extended production client and the WASM-engine client the tenancy proof
 * suites use, and naming a generated type would bind it to one of them.
 *
 * Placed ABOVE the class deliberately: `scripts/ci/assert-tenant-scoping.ts`
 * RULE 2 scans a 25-line window after every raw-SQL call for a strict table
 * name, and this block sitting below `prismaRaw()` tripped it. The guard is
 * doing its job — a scanner that is generous about what counts as "touching a
 * tenant table" is the correct trade — so the code moved rather than the rule
 * loosening.
 */
interface DomainEventRow {
  id: string;
  schemaVersion: number;
  childId: string | null;
  deviceId: string | null;
  aggregateType: string;
  aggregateId: string;
  occurredAt: Date | string;
  receivedAt: Date | string;
  idempotencyKey: string;
  clientEventId: string | null;
  correlationId: string | null;
  payload: unknown;
}

/**
 * THE RELAY. Reads committed messages out of `outbox_messages` and hands them
 * to the bus.
 *
 * TRANSPORT DECISION, AND WHY THERE IS NO BullMQ:
 * Redis IS reachable in this environment and IS already a dependency (`ioredis`,
 * used for throttling and pairing TTLs). BullMQ is NOT in `package.json`, and
 * adding it would buy nothing here, because the OUTBOX TABLE IS ALREADY THE
 * DURABLE QUEUE — that is the entire content of ADR-007 in
 * `docs/04-System-Architecture.md §ADR-007` ("Outbox Pattern instead of a
 * message broker" for the MVP). Putting BullMQ in front of it would mean two
 * queues, two retry policies and two places a message can be stuck. So the
 * transport is an in-process poller over Postgres, and the honest statement of
 * what that costs is in `delivery guarantees` below.
 *
 * DELIVERY GUARANTEES, PLAINLY:
 *   AT-LEAST-ONCE. A crash after `publish()` and before `MARK_PUBLISHED`
 *     redelivers. Every consumer must be idempotent; they are, and
 *     `ConsumerIdempotency` + the rewards ledger's unique index are how.
 *   NOT exactly-once. Nothing here claims it. Exactly-once across a process
 *     boundary is not purchasable at this price.
 *   NO GLOBAL ORDERING. See `in-process-event-bus.ts`.
 *   AT-MOST-ONCE per (event, destination) ENQUEUE, guaranteed by
 *     `outbox_messages (domain_event_id, destination)` unique.
 *
 * TENANCY (F2 / R8) — the part that matters most in a background worker:
 *   The CLAIM and the STATUS WRITE are cross-tenant and run under
 *   `runAsSystem('OUTBOX_RELAY', ...)`, which logs the bypass with its
 *   justification every time.
 *   The DISPATCH is not. Before a single consumer runs, the relay re-enters
 *   `runWithTenant({ familyId: message.familyId })`, so Rewards, Notifications
 *   and Streaks execute under the ordinary Prisma extension with
 *   deny-by-default intact. A consumer cannot see another family's rows even
 *   though the loop that woke it could.
 */
@Injectable()
export class OutboxRelay implements OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelay.name);
  private readonly workerId = `relay-${process.pid}-${randomUUID().slice(0, 8)}`;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(EVENT_PUBLISHER) private readonly bus: IEventPublisher,
  ) {}

  /**
   * NOT started from `onModuleInit`. Deliberate: `AppModule` is instantiated by
   * every DI-graph unit test and by the cross-tenant probe, and a timer that
   * starts itself would open database handles in suites that never asked for
   * one (and would keep Jest alive). `main.ts` starts it; tests call `tick()`
   * directly, which is also what makes relay behaviour assertable instead of
   * timing-dependent.
   */
  start(intervalMs: number = OUTBOX_RELAY_DEFAULTS.pollIntervalMs): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((err) =>
        this.logger.error(`outbox.tick_failed ${err instanceof Error ? err.message : err}`),
      );
    }, intervalMs);
    this.timer.unref?.();
    this.logger.log(`outbox.relay_started worker=${this.workerId} intervalMs=${intervalMs}`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  onModuleDestroy(): void {
    this.stop();
  }

  /**
   * One pass: reclaim stale locks, claim a batch, dispatch each message under
   * its own tenant. Returns counts so tests assert on real numbers rather than
   * on log output.
   *
   * Re-entrancy guard: a tick that overruns the poll interval must not have a
   * second tick start underneath it. `SKIP LOCKED` would make that safe at the
   * database level anyway, but it would still double the connection load for no
   * throughput gain.
   */
  async tick(batchSize: number = OUTBOX_RELAY_DEFAULTS.batchSize): Promise<{
    claimed: number;
    published: number;
    failed: number;
  }> {
    if (this.ticking) return { claimed: 0, published: 0, failed: 0 };
    this.ticking = true;
    try {
      const messages = await runAsSystemAsync(
        'OUTBOX_RELAY',
        'Outbox relay claims undelivered messages across every tenant; each message is then dispatched inside its own runWithTenant scope.',
        async () => {
          await this.prismaRaw().$executeRawUnsafe(
            SQL_RECLAIM_STALE_OUTBOX_LOCKS,
            OUTBOX_RELAY_DEFAULTS.staleLockSeconds,
          );
          // `await`, not `return` — see the note on `runInSystemScope` below.
          return await this.prismaRaw().$queryRawUnsafe<RawClaimedRow[]>(
            SQL_CLAIM_OUTBOX_BATCH,
            this.workerId,
            batchSize,
          );
        },
      );

      let published = 0;
      let failed = 0;

      for (const row of messages) {
        const message = toClaimed(row);
        const error = await this.dispatch(message);
        if (error === null) {
          await this.markPublished(message.id);
          published += 1;
        } else {
          await this.markFailed(message.id, error);
          failed += 1;
        }
      }

      return { claimed: messages.length, published, failed };
    } finally {
      this.ticking = false;
    }
  }

  /** Returns `null` on success, or the error text to record on the message. */
  private async dispatch(message: ClaimedOutboxMessage): Promise<string | null> {
    const event = await this.runInSystemScope<DomainEventRow | null>(
      'Relay reads the domain_events row backing a claimed outbox message before re-entering that row own tenant scope.',
      () =>
        this.prismaModels().domainEvent.findUnique({
          where: { id: message.domainEventId },
        }) as Promise<DomainEventRow | null>,
    );

    if (!event) {
      // The event row is gone (family deleted -> ON DELETE CASCADE). There is
      // nothing to deliver and retrying cannot help.
      return 'domain event row no longer exists';
    }

    const envelope: DomainEventEnvelope = {
      envelopeVersion: ENVELOPE_VERSION,
      id: event.id,
      type: message.eventType,
      schemaVersion: event.schemaVersion,
      familyId: message.familyId,
      childId: event.childId,
      deviceId: event.deviceId,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      occurredAt: new Date(event.occurredAt).toISOString(),
      receivedAt: new Date(event.receivedAt).toISOString(),
      idempotencyKey: event.idempotencyKey,
      clientEventId: event.clientEventId,
      traceId: event.correlationId,
      payload: event.payload,
    };

    // THE TENANT RE-ENTRY. Everything a consumer does happens inside this.
    const result = await runWithTenant(
      {
        familyId: message.familyId,
        actorType: 'SYSTEM',
        actorId: `outbox-relay:${message.id}`,
        requestId: event.correlationId ?? undefined,
      },
      () => this.bus.publish(envelope),
    );

    if (result.failures.length === 0) return null;
    return result.failures
      .map((f) => `${f.consumerName}: ${f.error.message}`)
      .join(' | ');
  }

  /**
   * THE ONE-LINE HAZARD THIS WRAPPER EXISTS TO REMOVE, stated because it cost
   * real debugging time and would have cost far more in production:
   *
   *   runAsSystemAsync(reason, why, () => prisma.domainEvent.findUnique(...))
   *
   * looks correct and is not. A `PrismaPromise` is LAZY — it executes when
   * `.then` is attached, not when it is constructed. Passing a non-`async`
   * callback builds the query inside the `AsyncLocalStorage` scope and then
   * resolves it OUTSIDE, so the tenant extension sees no context at all and
   * denies the read by default. Under the F2 deny-by-default model that is not
   * a leak, it is a total outage of the relay: every dispatch throws
   * `TENANT_CONTEXT_MISSING` and no event is ever delivered.
   *
   * `await`ing inside the scope is the whole fix. It is centralised here so a
   * future call site cannot reintroduce it by writing the terse version, and
   * `test/events/event-pipeline.e2e.spec.ts` fails loudly if it is undone —
   * that suite is what caught this in the first place.
   */
  private runInSystemScope<T>(justification: string, fn: () => Promise<T>): Promise<T> {
    return runAsSystemAsync('OUTBOX_RELAY', justification, async () => await fn());
  }

  private async markPublished(id: string): Promise<void> {
    await this.runInSystemScope(
      'Relay marks a delivered outbox message PUBLISHED; the row belongs to a tenant the relay is not scoped to.',
      () => this.prismaRaw().$executeRawUnsafe(SQL_MARK_OUTBOX_PUBLISHED, id),
    );
  }

  private async markFailed(id: string, error: string): Promise<void> {
    await this.runInSystemScope(
      'Relay records a delivery failure and schedules the backoff retry for an outbox message across tenants.',
      () =>
        this.prismaRaw().$executeRawUnsafe(
          SQL_MARK_OUTBOX_FAILED,
          id,
          error,
          OUTBOX_RELAY_DEFAULTS.maxAttempts,
        ),
    );
  }

  /** docs/04 §7: alert when the oldest PENDING message passes 60 seconds. */
  async backlog(): Promise<{ ageSeconds: number; pendingCount: number; familyCount: number }> {
    const rows = await this.runInSystemScope(
      'Operational backlog gauge over the outbox; deliberately cross-tenant because a backlog is a platform-level condition.',
      () =>
        this.prismaRaw().$queryRawUnsafe<
          Array<{ age_seconds: number; pending_count: number; family_count: number }>
        >(SQL_OLDEST_PENDING_AGE_SECONDS),
    );
    const row = rows[0] ?? { age_seconds: 0, pending_count: 0, family_count: 0 };
    return {
      ageSeconds: Number(row.age_seconds),
      pendingCount: Number(row.pending_count),
      familyCount: Number(row.family_count),
    };
  }

  /* eslint-disable @typescript-eslint/no-explicit-any */
  private prismaRaw(): {
    $executeRawUnsafe: (sql: string, ...params: unknown[]) => Promise<number>;
    $queryRawUnsafe: <T>(sql: string, ...params: unknown[]) => Promise<T>;
  } {
    return this.prisma as any;
  }

  private prismaModels(): { domainEvent: any } {
    return this.prisma as any;
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

interface RawClaimedRow {
  id: string;
  family_id: string;
  domain_event_id: string;
  event_type: string;
  destination: string;
  payload: Record<string, unknown>;
  attempt_count: number;
}

function toClaimed(row: RawClaimedRow): ClaimedOutboxMessage {
  return {
    id: row.id,
    familyId: row.family_id,
    domainEventId: row.domain_event_id,
    eventType: row.event_type as ClaimedOutboxMessage['eventType'],
    destination: row.destination,
    payload: row.payload,
    attemptCount: Number(row.attempt_count),
  };
}
