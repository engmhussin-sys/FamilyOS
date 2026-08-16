import { Injectable } from '@nestjs/common';

import type { JobDefinition } from '../domain/job.types';
import { DeadLetterAlertJob } from './jobs/dead-letter-alert.job';
import { ExpiredTokenSweepJob } from './jobs/expired-token-sweep.job';
import { FamilyDailyRolloverJob } from './jobs/family-daily-rollover.job';
import { NotificationDeliverySweepJob } from './jobs/notification-delivery-sweep.job';
import { RetentionSweepJob } from './jobs/retention-sweep.job';

/**
 * PHASE C P4 — THE ONE LIST OF JOBS THAT EXIST.
 *
 * An explicit constructor list rather than a decorator scan or a Nest
 * multi-provider token, and the reason is the same one that made the tenancy
 * registry an explicit list: a job that is registered by a decorator is a job
 * that can be UN-registered by deleting one line in a file nobody is reading,
 * and the failure mode of an unregistered job is silence. Here, adding a job
 * means importing it and naming it in one place, and
 * `test/scheduler/job-registry.spec.ts` asserts that this list and the
 * `scheduled_jobs` rows migration 0011 seeds are the SAME SET — a job in code
 * with no registry row would never be claimed, and a registry row with no code
 * would fail every tick. Both are caught before they reach an environment.
 */
@Injectable()
export class JobRegistry {
  private readonly byName: ReadonlyMap<string, JobDefinition>;

  constructor(
    retentionSweep: RetentionSweepJob,
    expiredTokenSweep: ExpiredTokenSweepJob,
    deadLetterAlert: DeadLetterAlertJob,
    familyDailyRollover: FamilyDailyRolloverJob,
    notificationDeliverySweep: NotificationDeliverySweepJob,
  ) {
    const definitions: JobDefinition[] = [
      retentionSweep.definition(),
      expiredTokenSweep.definition(),
      deadLetterAlert.definition(),
      familyDailyRollover.definition(),
      notificationDeliverySweep.definition(),
    ];

    const map = new Map<string, JobDefinition>();
    for (const def of definitions) {
      if (map.has(def.name)) {
        // Two jobs sharing a name would share a lease and a history row, i.e.
        // one of them would silently never run. Refused at construction so it
        // is a boot failure rather than a production mystery.
        throw new Error(`Duplicate scheduled job name: ${def.name}`);
      }
      map.set(def.name, def);
    }
    this.byName = map;
  }

  all(): readonly JobDefinition[] {
    return [...this.byName.values()];
  }

  names(): readonly string[] {
    return [...this.byName.keys()];
  }

  /** `undefined` for an unknown name — the caller decides whether that is an error. */
  get(name: string): JobDefinition | undefined {
    return this.byName.get(name);
  }
}
