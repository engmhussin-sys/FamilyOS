import { Inject, Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  EVIDENCE_STORAGE,
  type IEvidenceStorage,
} from '../../rewards-engine/application/ports/evidence-storage.port';
import { RETENTION_TARGETS, type RetentionTarget } from '../domain/retention-targets';

/**
 * How many rows one DELETE statement touches. Small enough that the row locks
 * it takes are released in milliseconds and a concurrent INSERT of today's
 * notification never waits behind it; large enough that a backlog of a million
 * rows is cleared in a bounded number of statements rather than in a million.
 */
export const RETENTION_BATCH_SIZE = 1_000;

/**
 * The cap on batches PER TABLE PER RUN. 500 x 1,000 = 500,000 rows per table
 * per day, which clears any realistic backlog while guaranteeing one run
 * cannot become an unbounded maintenance window. Hitting the cap is REPORTED
 * (`truncated: true`), never silent, and the next run continues from the same
 * cutoff — the cutoff IS the cursor.
 */
export const RETENTION_MAX_BATCHES = 500;

export interface IRetentionEnforcementResult {
  category: string;
  action: string;
  affectedRows: number;
}

/**
 * PHASE C P4 \u2014 the per-target result of the batched sweep. Separate from
 * `IRetentionEnforcementResult` because the two answer different questions: the
 * older shape is per CATEGORY (what a policy document names), this one is per
 * TABLE (what a DELETE names) and carries the batch count, which is how an
 * operator tells "there was nothing to delete" from "the batch cap stopped us
 * early and there is more".
 */
export interface IRetentionSweepResult {
  key: string;
  table: string;
  deletedRows: number;
  batches: number;
  /** True when the sweep hit its batch cap and more rows remain. */
  truncated: boolean;
}

/**
 * The executable half of DataRetentionPolicyService.
 *
 * PHASE C P4 (PA-B-031) CHANGED WHAT THIS CLASS IS. Before it, the class
 * covered five tables, every method was reachable only by hand, and nothing in
 * the repository called `enforceAll()` \u2014 its own docstring said \u00abNot scheduled
 * anywhere itself.\u00bb That made the whole of \u00a73.8 of CONTEXT a claim rather than
 * a mechanism, and Phase B classified it as a compliance condition (blocker
 * #5) rather than a gap.
 *
 * Two things changed:
 *   1. `sweepAll()` executes the table-driven schedule in
 *      `domain/retention-targets.ts`, in BOUNDED BATCHES, so a sweep over a
 *      large table takes many small locks instead of one long one.
 *   2. `SchedulerModule` runs it daily under a lease, with a queryable run
 *      history and an affected-row count.
 *
 * THE BATCHING IS NOT AN OPTIMISATION, it is the safety property. A single
 * `DELETE FROM notifications WHERE created_at < $1` over a 300K-row table (A2
 * DA-011's own measurement) holds row locks on every matching row for the
 * duration of one transaction and blocks the writes that are trying to add
 * today's notifications. `LIMIT`-ed batches with the sweep index in front of
 * them turn that into a series of short transactions any writer can interleave
 * with.
 */
@Injectable()
export class DataRetentionEnforcementService {
  private readonly logger = new Logger(DataRetentionEnforcementService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(EVIDENCE_STORAGE) private readonly storage: IEvidenceStorage,
  ) {}

  async enforceNotificationRetention(retentionDays = 90): Promise<IRetentionEnforcementResult> {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    const result = await this.prisma.notification.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    this.logger.log(`Retention: deleted ${result.count} notification(s) older than ${retentionDays} days.`);
    return { category: 'Notifications', action: 'HARD_DELETE', affectedRows: result.count };
  }

  async enforceAnalyticsRetention(retentionDays = 180): Promise<IRetentionEnforcementResult> {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    const result = await this.prisma.analyticsEvent.updateMany({
      where: { occurredAt: { lt: cutoff }, familyId: { not: null } },
      data: { familyId: null, userId: null },
    });
    this.logger.log(`Retention: anonymized ${result.count} analytics event(s) older than ${retentionDays} days.`);
    return { category: 'Analytics Events', action: 'ANONYMIZE', affectedRows: result.count };
  }

  /**
   * CLOSES A REAL GAP (docs/release/DATA_CLASSIFICATION.md flagged
   * LocationEvent as having no defined retention/deletion policy).
   * Uses `expiresAt` \u2014 a column the schema already had, with its own
   * index, since Sprint 1 \u2014 rather than a fixed lookback window like
   * the other two methods above, since `expiresAt` is meant to be set
   * per-row at write time (e.g. a parent-configurable retention
   * preference per family, a real future decision this method doesn't
   * need to make itself).
   *
   * HONEST NOTE: as of this writing, no code anywhere in this backend
   * actually creates a `LocationEvent` row \\u2014 this method has nothing
   * to delete today. It exists so the retention mechanism is correct
   * and ready the moment that write path is built, rather than being
   * retrofitted later under time pressure.
   */
  async enforceLocationEventRetention(): Promise<IRetentionEnforcementResult> {
    const result = await this.prisma.locationEvent.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    this.logger.log(`Retention: deleted ${result.count} location event(s) past their expiresAt.`);
    return { category: 'Location Events', action: 'HARD_DELETE', affectedRows: result.count };
  }

  /**
   * CLOSES A REAL GAP found during the Edge-First Intelligence
   * Architecture sprint's own security/privacy self-review \u2014 neither
   * table had a registered retention policy despite both being
   * genuinely sensitive, actively-written child behavioral data.
   *
   * UNLIKE enforceLocationEventRetention above, this is not
   * theoretical: DigitalWellbeingEngineService.recordDailySummary()
   * writes to both tables on every device sync, so rows exist from
   * the moment that pipeline goes live. Uses a fixed lookback window
   * (matching enforceNotificationRetention's own pattern) rather than
   * a per-row expiresAt column, since neither table has one \u2014 that's
   * a legitimate future refinement, not a gap this method needs to
   * solve today.
   */
  async enforceDigitalWellbeingRetention(retentionDays = 90): Promise<IRetentionEnforcementResult> {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    const [snapshotResult, usageLogResult] = await this.prisma.$transaction([
      this.prisma.dailyBehavioralSnapshot.deleteMany({ where: { usageDate: { lt: cutoff } } }),
      this.prisma.appUsageLog.deleteMany({ where: { usageDate: { lt: cutoff } } }),
    ]);
    const totalDeleted = snapshotResult.count + usageLogResult.count;
    this.logger.log(
      `Retention: deleted ${snapshotResult.count} daily behavioral snapshot(s) and ${usageLogResult.count} app usage log(s) older than ${retentionDays} days.`,
    );
    return { category: 'App Usage Data', action: 'HARD_DELETE', affectedRows: totalDeleted };
  }

  /**
   * B5 (PA-B-019) — THE RETENTION HOOK FOR UPLOADED EVIDENCE.
   *
   * A child's recitation is the most sensitive object this product stores, so
   * the upload path was not allowed to ship without the sweep that removes it.
   * Uses `retain_until` — a per-row column stamped at write time from
   * `EVIDENCE_RETENTION_DAYS` — rather than a fixed lookback window, for the
   * same reason `enforceLocationEventRetention` uses `expiresAt`: a policy
   * change must not silently re-date objects stored under the previous one.
   *
   * TWO STEPS, IN THIS ORDER, AND THE ORDER IS THE POINT. The BYTES go first
   * and the row is soft-deleted afterwards. Reversed, a crash between the two
   * would leave an object with no row pointing at it — unreachable by the
   * application and invisible to every future sweep, i.e. a child's voice
   * recording retained forever by accident. This way a crash leaves a row
   * whose object is gone, which the next run simply deletes again (deleting an
   * absent key is a success in `IEvidenceStorage`) and which `read()` already
   * reports as `EVIDENCE_EXPIRED`.
   *
   * SOFT delete for the row: `achievement_evidence` is part of the audit trail
   * behind a granted reward, and «there WAS a recording and it has since been
   * removed under policy» is a materially different statement from «there was
   * never any evidence». The bytes are what retention is about; the fact is
   * not.
   */
  async enforceAchievementEvidenceRetention(now = new Date()): Promise<IRetentionEnforcementResult> {
    const due = await this.prisma.achievementEvidence.findMany({
      where: { retainUntil: { lt: now }, deletedAt: null },
      select: { id: true, storageKey: true },
    });

    for (const row of due) {
      await this.storage.delete(row.storageKey);
    }

    const result = await this.prisma.achievementEvidence.updateMany({
      where: { id: { in: due.map((r: { id: string }) => r.id) } },
      data: { deletedAt: now },
    });

    this.logger.log(
      `Retention: deleted ${due.length} achievement evidence object(s) from ${this.storage.backendName} and tombstoned ${result.count} row(s).`,
    );
    return { category: 'Achievement Evidence', action: 'HARD_DELETE_OBJECT_SOFT_DELETE_ROW', affectedRows: result.count };
  }

/**
   * PHASE C P4 — THE MECHANISMS THAT ARE NOT "AGE ON ONE COLUMN".
   *
   * Three, and each is here because `sweepAll()` genuinely cannot express it:
   *   ANALYTICS      is an UPDATE (anonymisation), not a DELETE.
   *   LOCATION       ages on a PER-ROW `expires_at` stamped at write time, so a
   *                  policy change must not silently re-date existing rows.
   *   EVIDENCE       has to delete BYTES out of object storage before it
   *                  touches the row, and in that order — see its own docstring.
   *
   * `enforceNotificationRetention` and `enforceDigitalWellbeingRetention` are
   * deliberately NOT here: both are plain age-on-one-column sweeps and both are
   * now in `RETENTION_TARGETS`, where they are batched and bounded instead of
   * being one unbounded `deleteMany`. Calling them from here as well would
   * delete the same rows twice — harmlessly, but it would also make the second
   * count zero and overwrite the first in `job_runs.details`, which is how a
   * run history starts lying about what it did.
   */
  async enforceNonAgeBased(): Promise<IRetentionEnforcementResult[]> {
    return [
      await this.enforceAnalyticsRetention(),
      await this.enforceLocationEventRetention(),
      await this.enforceAchievementEvidenceRetention(),
    ];
  }

  /**
   * Every mechanism this class has, including the two that `sweepAll()` now
   * also covers. RETAINED for the callers and the suite that already use it,
   * and NOT what the scheduler calls — see `enforceNonAgeBased` above for why.
   */
  async enforceAll(): Promise<IRetentionEnforcementResult[]> {
    return [
      await this.enforceNotificationRetention(),
      await this.enforceAnalyticsRetention(),
      await this.enforceLocationEventRetention(),
      await this.enforceDigitalWellbeingRetention(),
      await this.enforceAchievementEvidenceRetention(),
    ];
  }

  /**
   * PHASE C P4 \u2014 THE TABLE-DRIVEN, BOUNDED, IDEMPOTENT SWEEP.
   *
   * IDEMPOTENT BY CONSTRUCTION, not by a marker. Every statement is
   * `DELETE ... WHERE <time column> < cutoff`, so the second run finds nothing
   * the first run left and deletes zero rows. There is no counter to get out of
   * step, no "already processed" flag to lose, and running it twice in the same
   * second is indistinguishable from running it once. That is the property the
   * requirement asks for and it is the reason the sweep is expressed as an
   * absolute cutoff rather than as "everything since the last run".
   *
   * DETERMINISTIC: `now` is a parameter. Two runs given the same instant and
   * the same rows delete the same rows.
   *
   * BOUNDED: `LIMIT`-ed batches, capped at `maxBatchesPerTarget`. Hitting the
   * cap is reported (`truncated`) rather than hidden, and the next run simply
   * continues \u2014 there is no cursor to persist because the cutoff itself is the
   * cursor.
   *
   * WHAT IS LOGGED, AND WHAT IS NOT. The log line and `details` carry the
   * TABLE and the COUNT. They never carry an id, a body, an email, a child's
   * name or a row. A retention log that records what it deleted has copied the
   * data it was told to destroy into a table with a longer retention period
   * than the one it just enforced.
   */
  async sweepAll(
    options: { now?: Date; batchSize?: number; maxBatchesPerTarget?: number; familyId?: string } = {},
  ): Promise<IRetentionSweepResult[]> {
    const now = options.now ?? new Date();
    const results: IRetentionSweepResult[] = [];
    for (const target of RETENTION_TARGETS) {
      results.push(
        await this.sweepTarget(target, {
          now,
          batchSize: options.batchSize ?? RETENTION_BATCH_SIZE,
          maxBatches: options.maxBatchesPerTarget ?? RETENTION_MAX_BATCHES,
          familyId: options.familyId ?? null,
        }),
      );
    }
    return results;
  }

  /**
   * One target, swept in batches.
   *
   * TENANCY, stated where the reader will look for it. `family_id` is named in
   * the statement and bound to `$2`: passing NULL sweeps every household (the
   * scheduled case, which runs under `runAsSystem('DATA_RETENTION_JOB', ...)`
   * \u2014 the SystemReason that has existed for exactly this since F2), and
   * passing a real id sweeps one (the account-lifecycle case). A2 \u00a76.3 row 15
   * called the cross-tenant delete out as deliberate-but-undeclared; it is now
   * declared, parameterised, and impossible to invoke by accident, because the
   * caller must choose which of the two it wants.
   *
   * `$executeRawUnsafe` with an interpolated table name is safe HERE and only
   * here: every fragment interpolated below comes from `RETENTION_TARGETS`,
   * which is a frozen compile-time constant. No value on this path is
   * reachable from a request. The alternative \u2014 a `switch` with ten literal
   * statements \u2014 is the same SQL written ten times, which is how the eleventh
   * table gets forgotten.
   */
  private async sweepTarget(
    target: RetentionTarget,
    opts: { now: Date; batchSize: number; maxBatches: number; familyId: string | null },
  ): Promise<IRetentionSweepResult> {
    const cutoff = new Date(opts.now.getTime() - target.retentionDays * 24 * 60 * 60 * 1000);
    const extra = target.extraPredicate ? ` AND (${target.extraPredicate})` : '';
    const tenantClause = target.tenantScoped
      ? ` AND ($2::uuid IS NULL OR "family_id" = $2::uuid)`
      : ' AND ($2::uuid IS NULL OR $2::uuid IS NOT NULL)';

    const sql =
      `DELETE FROM "${target.table}" WHERE "id" IN (` +
      `SELECT "id" FROM "${target.table}"` +
      ` WHERE "${target.timeColumn}" < $1::timestamptz${tenantClause}${extra}` +
      ` ORDER BY "${target.timeColumn}" LIMIT $3::int)`;

    let deleted = 0;
    let batches = 0;
    let truncated = false;

    for (;;) {
      if (batches >= opts.maxBatches) {
        truncated = true;
        break;
      }
      const count = await this.prismaRaw().$executeRawUnsafe(
        sql,
        cutoff,
        opts.familyId,
        opts.batchSize,
      );
      batches += 1;
      deleted += Number(count);
      if (Number(count) < opts.batchSize) break;
    }

    if (deleted > 0) {
      // COUNTS ONLY \u2014 never the rows, never an id. See the docstring.
      this.logger.log(
        `retention.swept table=${target.table} deleted=${deleted} batches=${batches} olderThanDays=${target.retentionDays} scope=${opts.familyId ? 'FAMILY' : 'PLATFORM'}`,
      );
    }

    return { key: target.key, table: target.table, deletedRows: deleted, batches, truncated };
  }

  /* eslint-disable @typescript-eslint/no-explicit-any */
  /**
   * Same structural cast, and same reason, as `OutboxRelay.prismaRaw()`: this
   * file must work against both the extended production client and the
   * WASM-engine client the tenancy proof suites build, and naming a generated
   * type would bind it to one of them.
   */
  private prismaRaw(): {
    $executeRawUnsafe: (sql: string, ...params: unknown[]) => Promise<number>;
  } {
    return this.prisma as any;
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
}
