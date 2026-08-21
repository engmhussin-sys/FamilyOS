import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../../../common/prisma/prisma.service';
import { runAsSystemAsync } from '../../../../common/tenancy/system-context';
import { runWithTenant } from '../../../../common/tenancy/tenant-context';
import type { JobOutcome } from '../../../scheduler/domain/job.types';
import { DEVICE_LIVENESS_BATCH_SIZE, DEVICE_STALE_AFTER_HOURS, staleCutoff } from '../../domain/device-liveness';
import { PairingStateMachineService } from './pairing-state-machine.service';

interface StaleDeviceRow {
  device_id: string;
  family_id: string;
  child_id: string | null;
  last_seen_at: Date;
}

/**
 * ===========================================================================
 * THE PRODUCER `HEARTBEAT_MISSED` NEVER HAD.
 * ===========================================================================
 *
 * The rule it applies lives in `domain/device-liveness.ts` and is argued there.
 * This class is the part that has to touch two tenants' worth of rows, and
 * every decision in it is about doing that honestly.
 *
 * ── TWO CONTEXTS, ON PURPOSE ───────────────────────────────────────────
 *
 * FINDING the stale devices is cross-tenant: «which devices anywhere have gone
 * quiet» is a platform question and no family may ask it. That read runs under
 * `runAsSystem`, which logs its reason, and it is raw SQL because the tenant
 * extension would otherwise rewrite it to one family.
 *
 * ACTING on each one is NOT cross-tenant. Writing the pairing event, and
 * reading the child's current state to decide whether the event is legal, are
 * both operations on ONE household's rows — so each device is handled inside
 * `runWithTenant({ familyId })` and the extension stamps and filters exactly as
 * it would for an HTTP request. This is the same shape `family-daily-rollover`
 * uses, and it is the difference between «the platform wrote a row into a
 * family» and «a row was written in that family's own context». The audit
 * trail reads correctly only in the second.
 *
 * `actorType: 'SYSTEM'` on the tenant context is the case `TenantActorType`
 * documents itself as existing for: a background sweep acting inside a
 * household that no human is currently in.
 *
 * ── IT REFUSES RATHER THAN FORCES ──────────────────────────────────────
 *
 * The state machine owns whether `HEALTHY -> DEGRADED` is legal right now, and
 * this service does not second-guess it. A device whose child is in any other
 * state raises `InvalidPairingTransitionException`, which is CAUGHT AND
 * COUNTED, not logged as an error: it is the normal outcome for a device that
 * is already degraded, already revoked, or still mid-pairing, and it is what
 * makes a sweep every hour cost one row per outage instead of one row per hour.
 *
 * A device with no `child_id` is skipped for a different reason and counted
 * separately: the pairing timeline is keyed on the CHILD, so a device row
 * without one has no timeline to transition.
 */
@Injectable()
export class DeviceLivenessService {
  private readonly logger = new Logger(DeviceLivenessService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stateMachine: PairingStateMachineService,
  ) {}

  async sweep(now: Date): Promise<JobOutcome> {
    const cutoff = staleCutoff(now);

    const candidates = await runAsSystemAsync(
      'SCHEDULED_JOB',
      'Scheduled sweep finds devices whose heartbeat stopped across every household; «which devices anywhere have gone quiet» is a platform-level question with no single tenant.',
      async () =>
        this.prisma.$queryRaw<StaleDeviceRow[]>`
          SELECT d.id AS device_id, d.family_id, d.child_id, d.last_seen_at
            FROM devices d
           WHERE d.status = 'ACTIVE'
             AND d.owner_type = 'CHILD'
             AND d.deleted_at IS NULL
             AND d.last_seen_at IS NOT NULL
             AND d.last_seen_at < ${cutoff}
           ORDER BY d.last_seen_at ASC
           LIMIT ${DEVICE_LIVENESS_BATCH_SIZE}`,
    );

    let degraded = 0;
    let alreadyNotHealthy = 0;
    let withoutChild = 0;

    for (const row of candidates) {
      if (row.child_id === null) {
        withoutChild += 1;
        continue;
      }

      try {
        await runWithTenant(
          { familyId: row.family_id, actorType: 'SYSTEM', actorId: DEVICE_LIVENESS_ACTOR },
          () =>
            this.stateMachine.transition({
              childId: row.child_id as string,
              deviceId: row.device_id,
              event: 'HEARTBEAT_MISSED',
              actorType: 'SYSTEM',
              // Counts and instants only. WHY the device went quiet is not
              // knowable from here, and a metadata field guessing at it would
              // be read later as though somebody had measured it.
              metadata: {
                lastSeenAt: row.last_seen_at.toISOString(),
                thresholdHours: DEVICE_STALE_AFTER_HOURS,
                silentHours: Math.floor((now.getTime() - row.last_seen_at.getTime()) / 3_600_000),
              },
            }),
        );
        degraded += 1;
      } catch {
        // The expected outcome for most rows on most runs: the device is
        // already DEGRADED (or revoked, or mid-pairing), so the transition is
        // illegal and nothing should happen. Counted, never thrown — a sweep
        // that failed because a device was already in the state it is supposed
        // to reach would be a sweep that cannot run twice.
        alreadyNotHealthy += 1;
      }
    }

    if (degraded > 0) {
      this.logger.log(
        JSON.stringify({ event: 'device_liveness.degraded', count: degraded, thresholdHours: DEVICE_STALE_AFTER_HOURS }),
      );
    }

    return {
      affectedRows: degraded,
      details: {
        examined: candidates.length,
        degraded,
        alreadyNotHealthy,
        withoutChild,
        // Named so a future silent truncation is visible: a sweep that returns
        // exactly the batch size has probably not finished the table.
        batchSize: DEVICE_LIVENESS_BATCH_SIZE,
      },
    };
  }
}

/** Recorded as the actor on every event this sweep writes, so the pairing
 * timeline distinguishes «the platform noticed silence» from «a parent acted». */
export const DEVICE_LIVENESS_ACTOR = 'device-liveness-sweep';
