/**
 * PHASE C P4 — THE REGISTRY AND THE MIGRATION CANNOT DRIFT.
 *
 * A scheduled job has TWO halves that live in different files: the code that
 * does the work (`JobRegistry`) and the row that says when to do it
 * (`scheduled_jobs`, seeded by migration 0011). Each half fails silently
 * without the other, and in opposite directions:
 *
 *   code without a row  -> never claimed, never runs, NEVER FAILS. Perfectly
 *                          invisible. This is the dangerous one, and it is
 *                          exactly the shape retention already had for a year:
 *                          an implementation with no trigger.
 *   row without code    -> fails every tick forever, which at least is loud.
 *
 * So this suite reads the migration SQL as text and asserts the two sets are
 * identical. It deliberately does NOT go through Prisma or the database: the
 * question is about the SOURCE that will be applied to a fresh environment, and
 * a database that happens to have the right rows today proves nothing about
 * the next one.
 */
import * as fs from 'fs';
import * as path from 'path';

import { DeadLetterAlertJob } from '../../src/modules/scheduler/application/jobs/dead-letter-alert.job';
import { ExpiredTokenSweepJob } from '../../src/modules/scheduler/application/jobs/expired-token-sweep.job';
import { FamilyDailyRolloverJob } from '../../src/modules/scheduler/application/jobs/family-daily-rollover.job';
import { NotificationDeliverySweepJob } from '../../src/modules/scheduler/application/jobs/notification-delivery-sweep.job';
import { RetentionSweepJob } from '../../src/modules/scheduler/application/jobs/retention-sweep.job';
import { JobRegistry } from '../../src/modules/scheduler/application/job-registry.service';

/**
 * PHASE D: the seed is no longer in ONE file. Migration 0011 created the
 * registry and seeded four jobs; migration 0014 seeded the fifth
 * (`notification-delivery-sweep`). The set this suite compares against is
 * therefore the UNION of every migration that inserts into `scheduled_jobs` —
 * discovered by reading the directory rather than by listing filenames, so a
 * sixth job seeded by a future migration is caught by this test on the day it
 * is written instead of on the day someone remembers to add it here.
 */
const MIGRATIONS_DIR = path.resolve(__dirname, '../../prisma/migrations');

interface SeededJob {
  name: string;
  scope: string;
  cadenceSeconds: number;
  localHour: number | null;
}

/** Parses every `INSERT INTO "scheduled_jobs" ... VALUES (...)` row in every migration. */
function seededJobs(): SeededJob[] {
  const jobs: SeededJob[] = [];
  for (const dir of fs.readdirSync(MIGRATIONS_DIR).sort()) {
    const file = path.join(MIGRATIONS_DIR, dir, 'migration.sql');
    if (!fs.existsSync(file)) continue;
    const sql = fs.readFileSync(file, 'utf8');
    if (!sql.includes('INSERT INTO "scheduled_jobs"')) continue;
    const rows = [
      ...sql.matchAll(/\(\s*'([a-z-]+)',\s*'(PLATFORM|FAMILY)',\s*(\d+),\s*(NULL|\d+),\s*(true|false)\s*\)/g),
    ];
    for (const m of rows) {
      jobs.push({
        name: m[1],
        scope: m[2],
        cadenceSeconds: Number(m[3]),
        localHour: m[4] === 'NULL' ? null : Number(m[4]),
      });
    }
  }
  return jobs;
}

/**
 * Built by hand rather than through the Nest testing module: the registry's
 * constructor takes four job objects and calls `definition()` on each, and
 * `definition()` touches nothing — no database, no Redis, no clock. Wiring a
 * DI container to prove a list is a list would only add a way for this suite to
 * fail for an unrelated reason.
 */
function registry(): JobRegistry {
  const stub = <T>(): T => ({}) as T;
  return new JobRegistry(
    new RetentionSweepJob(stub()),
    new ExpiredTokenSweepJob(stub()),
    new DeadLetterAlertJob(stub()),
    new FamilyDailyRolloverJob(stub(), stub()),
    new NotificationDeliverySweepJob(stub()),
  );
}

describe('PHASE C P4 / PHASE D — job registry ↔ the migration seeds', () => {
  it('registers exactly the jobs the migrations seed — no more, no fewer', () => {
    const inCode = [...registry().names()].sort();
    const inMigration = seededJobs()
      .map((j) => j.name)
      .sort();

    expect(inCode).toEqual(inMigration);
    expect(inCode).toEqual([
      'data-retention-sweep',
      'expired-token-sweep',
      'family-daily-rollover',
      // PHASE D (PC-D-005): the quiet-hours release, seeded by migration 0014.
      'notification-delivery-sweep',
      'outbox-dead-letter-alert',
    ]);
  });

  it('agrees with the migration about every job SCOPE', () => {
    const byName = new Map(registry().all().map((d) => [d.name, d.scope]));
    for (const seeded of seededJobs()) {
      expect(byName.get(seeded.name)).toBe(seeded.scope);
    }
  });

  it('gives every FAMILY job a local rollover hour and every PLATFORM job none', () => {
    // The same invariant migration 0011 puts a CHECK constraint on. Asserted
    // here too because a CHECK only fires on write, and a seed that is wrong is
    // wrong before anybody writes anything else.
    for (const seeded of seededJobs()) {
      if (seeded.scope === 'FAMILY') {
        expect(seeded.localHour).not.toBeNull();
        expect(seeded.localHour).toBeGreaterThanOrEqual(0);
        expect(seeded.localHour).toBeLessThanOrEqual(23);
      } else {
        expect(seeded.localHour).toBeNull();
      }
    }
  });

  it('gives every job a positive cadence and a non-empty Arabic description', () => {
    for (const seeded of seededJobs()) expect(seeded.cadenceSeconds).toBeGreaterThan(0);
    for (const def of registry().all()) {
      expect(def.description.trim().length).toBeGreaterThan(20);
      // The operational surface is read by Arabic-speaking operators; a job
      // whose description is English is a job whose description was forgotten.
      expect(/[؀-ۿ]/.test(def.description)).toBe(true);
    }
  });

  it('refuses two jobs with the same name at construction rather than at runtime', () => {
    const stub = <T>(): T => ({}) as T;
    const duplicate = new RetentionSweepJob(stub());
    expect(
      () =>
        new JobRegistry(
          duplicate,
          // The second argument's `definition()` returns the same name.
          duplicate as unknown as ExpiredTokenSweepJob,
          new DeadLetterAlertJob(stub()),
          new FamilyDailyRolloverJob(stub(), stub()),
          new NotificationDeliverySweepJob(stub()),
        ),
    ).toThrow(/Duplicate scheduled job name/);
  });

  it('exposes an unknown name as undefined rather than throwing', () => {
    expect(registry().get('no-such-job')).toBeUndefined();
  });
});
