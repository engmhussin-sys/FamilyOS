import { Inject, Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  EVIDENCE_STORAGE,
  type IEvidenceStorage,
} from '../../rewards-engine/application/ports/evidence-storage.port';

export interface IRetentionEnforcementResult {
  category: string;
  action: string;
  affectedRows: number;
}

/**
 * The executable half of DataRetentionPolicyService \u2014 deliberately
 * covers only the two categories whose policy is unambiguous enough to
 * automate safely: Notifications (hard delete, purely transient) and
 * Analytics Events (anonymize, already PII-filtered). Every other
 * category in the policy table requires a human decision before
 * deletion (audit/compliance data) or has nothing to delete (cached
 * state, on-demand reports) \u2014 this class does NOT attempt those, on
 * purpose, per DataRetentionPolicyService's own docstring.
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

  /** Runs both \u2014 the method a future scheduler (once chosen) would
   * call. Not scheduled anywhere itself. */
  async enforceAll(): Promise<IRetentionEnforcementResult[]> {
    return [
      await this.enforceNotificationRetention(),
      await this.enforceAnalyticsRetention(),
      await this.enforceLocationEventRetention(),
      await this.enforceDigitalWellbeingRetention(),
      await this.enforceAchievementEvidenceRetention(),
    ];
  }
}
