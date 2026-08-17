import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../../common/prisma/prisma.service';
import { runAsSystemAsync } from '../../../../common/tenancy/system-context';
import type { INotificationDeliveryRepository } from '../../application/ports/notification-delivery.repository.port';
import {
  RELEASE_DEFAULTS,
  type DeferredNotificationRow,
  type DeliveryBacklogReport,
  type EnqueueDeferredInput,
  type ResolutionReason,
} from '../../domain/notification-delivery.types';
import {
  SQL_CLAIM_DUE_DELIVERIES,
  SQL_DEAD_DELIVERIES_BY_TYPE,
  SQL_DELIVERY_BACKLOG,
  SQL_ENQUEUE_DEFERRED,
  SQL_LIST_FAMILIES_WITH_DUE_DELIVERIES,
  SQL_MARK_ATTEMPT_FAILED,
  SQL_MARK_DELIVERED,
  SQL_MARK_SUPPRESSED,
  SQL_RECLAIM_STALE_DELIVERY_LOCKS,
  SQL_REDEFER,
} from '../notification-delivery.sql';

/** The raw shape `SQL_CLAIM_DUE_DELIVERIES` returns. Declared structurally, for
 * the same reason `OutboxRelay` declares `DomainEventRow` structurally: this
 * code runs against both the extended production client and the WASM-engine
 * client the tenancy suites build, and naming a generated type binds it to one. */
interface ClaimedRow {
  id: string;
  family_id: string;
  child_id: string | null;
  type: string;
  category: string;
  priority: string;
  target_audience: string;
  title: string;
  body: string;
  source_event_id: string;
  data: Record<string, unknown> | null;
  scheduled_for: Date | string;
  business_date: Date | string;
  attempt_count: number | bigint;
  created_at: Date | string;
}

const KNOWN_PRIORITIES = new Set(['CRITICAL', 'HIGH', 'NORMAL', 'LOW']);

/**
 * PHASE D (`PC-D-005`) — RAW SQL, NOT THE PRISMA MODEL API, AND WHY.
 *
 * Three of the six write methods need something Prisma cannot express: an
 * `UPDATE ... FROM (SELECT ... FOR UPDATE SKIP LOCKED)` claim, an
 * `ON CONFLICT DO NOTHING` insert that reports whether it wrote, and a state
 * transition whose next value is computed from the row's own `attempt_count`.
 * Every one of those is a CONCURRENCY property, and expressing a concurrency
 * property as read-then-write in application code is how the original
 * five-minute-window notification bug was written. Same decision, same reason,
 * as `outbox.sql.ts` and `rewards.sql.ts`.
 */
@Injectable()
export class PrismaNotificationDeliveryRepository implements INotificationDeliveryRepository {
  constructor(private readonly prisma: PrismaService) {}

  async enqueue(input: EnqueueDeferredInput): Promise<string | null> {
    const rows = await this.raw().$queryRawUnsafe<Array<{ id: string }>>(
      SQL_ENQUEUE_DEFERRED,
      input.familyId,
      input.childId,
      input.type,
      input.category,
      input.priority,
      input.targetAudience,
      input.title,
      input.body,
      input.sourceEventId,
      input.deferReason,
      input.scheduledFor,
      input.businessDate,
      // PHASE E (`PD-N-004`). `$13::jsonb` — a JS object handed to a `jsonb`
      // parameter through the raw driver is serialised by the driver, so it is
      // stringified here explicitly rather than relying on that: `undefined`
      // and `null` must both reach the column as SQL NULL, and only one of them
      // does implicitly.
      input.data == null ? null : JSON.stringify(input.data),
    );
    return rows[0]?.id ?? null;
  }

  async familiesWithDueDeliveries(now: Date, limit: number): Promise<string[]> {
    return runAsSystemAsync(
      'NOTIFICATION_RELEASE',
      'The quiet-hours release sweep enumerates the families that have a notification due; it reads TENANT IDS ONLY and then re-enters runWithTenant for each one before touching a single row of content.',
      async () => {
        const rows = await this.raw().$queryRawUnsafe<Array<{ family_id: string }>>(
          SQL_LIST_FAMILIES_WITH_DUE_DELIVERIES,
          now,
          limit,
        );
        return rows.map((r) => r.family_id);
      },
    );
  }

  async claimDue(
    familyId: string,
    workerId: string,
    now: Date,
    limit: number,
  ): Promise<DeferredNotificationRow[]> {
    const rows = await this.raw().$queryRawUnsafe<ClaimedRow[]>(
      SQL_CLAIM_DUE_DELIVERIES,
      familyId,
      workerId,
      now,
      limit,
    );
    return rows.map((r) => ({
      id: r.id,
      familyId: r.family_id,
      childId: r.child_id,
      type: r.type,
      category: r.category,
      // The column is an open VARCHAR (this schema's established pattern for
      // classification fields); an unexpected stored value degrades to NORMAL
      // rather than crashing a release sweep.
      priority: (KNOWN_PRIORITIES.has(r.priority) ? r.priority : 'NORMAL') as
        | 'CRITICAL'
        | 'HIGH'
        | 'NORMAL'
        | 'LOW',
      targetAudience: r.target_audience === 'CHILD' ? 'CHILD' : 'PARENT',
      title: r.title,
      body: r.body,
      sourceEventId: r.source_event_id,
      data: r.data ?? null,
      scheduledFor: new Date(r.scheduled_for),
      businessDate: new Date(r.business_date).toISOString().slice(0, 10),
      attemptCount: Number(r.attempt_count),
      createdAt: new Date(r.created_at),
    }));
  }

  /** Scoped by `family_id IS NOT NULL` in the statement itself, plus the row's
   * own id — see `SQL_MARK_DELIVERED`. */
  async markDelivered(id: string): Promise<void> {
    await this.raw().$executeRawUnsafe(SQL_MARK_DELIVERED, id);
  }

  /** Scoped by `family_id IS NOT NULL` in `SQL_MARK_SUPPRESSED`; the reason is
   * required by the CHECK constraint, not merely by this signature. */
  async markSuppressed(id: string, reason: ResolutionReason): Promise<void> {
    await this.raw().$executeRawUnsafe(SQL_MARK_SUPPRESSED, id, reason);
  }

  /** Scoped by `family_id IS NOT NULL` in `SQL_MARK_ATTEMPT_FAILED`, which also
   * decides PENDING-with-backoff vs terminal DEAD from the row's own
   * `attempt_count` rather than from anything this method passes. */
  async markAttemptFailed(id: string, error: string): Promise<void> {
    await this.raw().$executeRawUnsafe(
      SQL_MARK_ATTEMPT_FAILED,
      id,
      error,
      RELEASE_DEFAULTS.maxAttempts,
      RELEASE_DEFAULTS.retryBaseSeconds,
      RELEASE_DEFAULTS.retryMaxSeconds,
    );
  }

  /** Scoped by `family_id IS NOT NULL` in `SQL_REDEFER`. */
  async redefer(id: string, scheduledFor: Date): Promise<void> {
    await this.raw().$executeRawUnsafe(SQL_REDEFER, id, scheduledFor);
  }

  async backlog(): Promise<DeliveryBacklogReport> {
    return runAsSystemAsync(
      'NOTIFICATION_RELEASE',
      'The operator gauge for undeliverable notifications is cross-tenant by definition — it is an alert, not a household view — and returns counts and type names only, never a title, a body, a child or a family.',
      async () => {
        // Both statements name `family_id IS NOT NULL` explicitly even though
        // they are deliberately cross-tenant: the predicate is what keeps the
        // gauge over real household rows rather than over anything a future
        // nullable-tenant row could add, and CI RULE 2 requires raw SQL over a
        // strict table to say so itself rather than to rely on ambient context.
        const [totals] = await this.raw().$queryRawUnsafe<
          Array<{ pending: number; dead: number; oldest_pending_age_seconds: number }>
        >(SQL_DELIVERY_BACKLOG);
        const byType = await this.raw().$queryRawUnsafe<Array<{ type: string; count: number }>>(
          SQL_DEAD_DELIVERIES_BY_TYPE,
        );
        return {
          pending: Number(totals?.pending ?? 0),
          dead: Number(totals?.dead ?? 0),
          oldestPendingAgeSeconds: Number(totals?.oldest_pending_age_seconds ?? 0),
          deadByType: byType.map((r) => ({ type: r.type, count: Number(r.count) })),
        };
      },
    );
  }

  async reclaimStaleLocks(leaseSeconds: number): Promise<number> {
    return runAsSystemAsync(
      'NOTIFICATION_RELEASE',
      'Frees rows still marked DELIVERING by a replica that died; the sweep spans tenants because a dead worker held rows for whichever families it had claimed, and the statement still names family_id itself.',
      async () => this.raw().$executeRawUnsafe(SQL_RECLAIM_STALE_DELIVERY_LOCKS, leaseSeconds),
    );
  }

  /* eslint-disable @typescript-eslint/no-explicit-any */
  /** Same structural cast, same reason, as `OutboxRelay.prismaRaw()`. */
  private raw(): {
    $executeRawUnsafe: (sql: string, ...params: unknown[]) => Promise<number>;
    $queryRawUnsafe: <T>(sql: string, ...params: unknown[]) => Promise<T>;
  } {
    return this.prisma as any;
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
}
