import type {
  DeferredNotificationRow,
  DeliveryBacklogReport,
  EnqueueDeferredInput,
  ResolutionReason,
} from '../../domain/notification-delivery.types';

export const NOTIFICATION_DELIVERY_REPOSITORY = Symbol('NOTIFICATION_DELIVERY_REPOSITORY');

/**
 * PHASE D (`PC-D-005`) — the write side of the deferral queue.
 *
 * A PORT rather than a concrete class for the same reason
 * `INotificationRepository` is one: `SmartNotificationIntegrationService` lives
 * in `life-intelligence` and the table lives here, and an interface is what
 * keeps that a dependency on a contract rather than on a Prisma model.
 *
 * NOTE WHAT IS NOT ON THIS INTERFACE: any method that DELIVERS. Delivery routes
 * through `IRuntimeAlertRepository.createForFamilyOwner` (parents) and
 * `FamilyCommunicationService.draftAiMessageIfAbsent` (children) — the two
 * paths that already existed and that already enforce owner resolution, push
 * fan-out and the child-message approval gate. A `deliver()` here would be the
 * second notification engine the brief forbids.
 */
export interface INotificationDeliveryRepository {
  /** `null` when `(family_id, source_event_id)` already had a row — a
   * redelivered cause, correctly ignored. */
  enqueue(input: EnqueueDeferredInput): Promise<string | null>;

  /** Tenant ids only, cross-tenant, for the sweep's fan-out. */
  familiesWithDueDeliveries(now: Date, limit: number): Promise<string[]>;

  /** Claims one family's due rows under a lease. Runs inside `runWithTenant`. */
  claimDue(
    familyId: string,
    workerId: string,
    now: Date,
    limit: number,
  ): Promise<DeferredNotificationRow[]>;

  markDelivered(id: string): Promise<void>;
  /** The reason is REQUIRED — migration 0014's CHECK refuses the row without it. */
  markSuppressed(id: string, reason: ResolutionReason): Promise<void>;
  /** Backoff or DEAD, decided in SQL from `attempt_count`. */
  markAttemptFailed(id: string, error: string): Promise<void>;
  /** Back to PENDING at a new family-local instant. */
  redefer(id: string, scheduledFor: Date): Promise<void>;

  /** The operator gauge. DEAD counted separately from PENDING, on purpose. */
  backlog(): Promise<DeliveryBacklogReport>;
  /** Frees rows held by a replica that died. */
  reclaimStaleLocks(leaseSeconds: number): Promise<number>;
}
