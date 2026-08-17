/* eslint-disable @typescript-eslint/no-explicit-any */
import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../../common/prisma/prisma.service';
import { runAsSystemAsync } from '../../../../common/tenancy/system-context';
import {
  NotificationPolicySettingError,
  parsePolicySetting,
} from '../../domain/engine/notification-policy';
import type { NotificationDecisionVerdict } from '../../domain/engine/notification-decision.types';
import type {
  DecisionAnalyticsFilter,
  DecisionAnalyticsReport,
  DecisionLedgerRow,
  INotificationDecisionRepository,
  INotificationPolicyRepository,
  RecordDecisionInput,
} from '../../application/ports/notification-decision.repository.port';
import {
  SQL_DECISION_ANALYTICS,
  SQL_DECISION_TOP_TYPES,
  SQL_LIST_DECISIONS_FOR_FAMILY,
  SQL_READ_POLICY_SETTINGS,
  SQL_RECORD_DECISION,
  SQL_RECORD_OUTCOME,
  SQL_UPSERT_POLICY_SETTING,
} from '../notification-decision.sql';

/**
 * PHASE F (`F6-002`) — RAW SQL, FOR `PrismaNotificationDeliveryRepository`'S
 * REASONS AND ONE MORE.
 *
 * The shared reasons: `ON CONFLICT DO NOTHING` that REPORTS whether it wrote,
 * and a nine-numerator aggregate over one scan. Both are things Prisma's model
 * API cannot express, and expressing an idempotency property as read-then-write
 * in application code is how the original notification duplication bug was
 * written.
 *
 * The extra one: the analytics query joins `notification_decisions` to
 * `notifications` ON THE CAUSAL KEY, not on a foreign key, precisely because the
 * notification row may not exist. That LEFT JOIN is the whole shape of the
 * measurement — a decision with no notification is the case the ledger was built
 * for — and a relation-based query would have to invent a relation that the
 * interesting rows do not have.
 */
@Injectable()
export class PrismaNotificationDecisionRepository implements INotificationDecisionRepository {
  constructor(private readonly prisma: PrismaService) {}

  async record(input: RecordDecisionInput): Promise<string | null> {
    const d = input.decision;
    const rows = await this.raw().$queryRawUnsafe<Array<{ id: string }>>(
      SQL_RECORD_DECISION,
      input.familyId,
      input.childId,
      input.sourceEventId,
      d.trigger,
      input.eventType,
      d.notificationType,
      d.category,
      d.targetAudience,
      d.verdict,
      d.band,
      d.score,
      d.reason,
      // `$13::jsonb` — stringified explicitly rather than relying on the driver,
      // for `SQL_ENQUEUE_DEFERRED`'s stated reason: `undefined` and `null` must
      // both reach the column deterministically, and only one of them does
      // implicitly.
      JSON.stringify(d.components ?? []),
      d.providerId,
      input.ageBand,
      input.locale,
      input.countryCode,
      input.aiRewritten,
      input.aiFailed,
      input.copyKey,
      input.businessDate,
    );
    return rows[0]?.id ?? null;
  }

  async recordOutcome(
    familyId: string,
    decisionId: string,
    outcome: NotificationDecisionVerdict,
    outcomeReason: string | null,
  ): Promise<void> {
    await this.raw().$executeRawUnsafe(
      SQL_RECORD_OUTCOME,
      familyId,
      decisionId,
      outcome,
      outcomeReason,
    );
  }

  async listForFamily(familyId: string, limit: number): Promise<DecisionLedgerRow[]> {
    const rows = await this.raw().$queryRawUnsafe<any[]>(
      SQL_LIST_DECISIONS_FOR_FAMILY,
      familyId,
      limit,
    );
    return rows.map((r) => ({
      id: r.id,
      childId: r.child_id,
      sourceEventId: r.source_event_id,
      trigger: r.trigger,
      eventType: r.event_type,
      notificationType: r.notification_type,
      category: r.category,
      targetAudience: r.target_audience,
      decision: r.decision,
      priorityBand: r.priority_band,
      score: Number(r.score),
      reason: r.reason,
      explanation: r.explanation,
      providerId: r.provider_id,
      ageBand: r.age_band,
      locale: r.locale,
      countryCode: r.country_code,
      aiRewritten: Boolean(r.ai_rewritten),
      aiFailed: Boolean(r.ai_failed),
      copyKey: r.copy_key,
      outcome: r.outcome,
      outcomeReason: r.outcome_reason,
      businessDate: new Date(r.business_date).toISOString().slice(0, 10),
      createdAt: new Date(r.created_at),
    }));
  }

  async analytics(
    filter: DecisionAnalyticsFilter,
    topTypesLimit: number,
  ): Promise<DecisionAnalyticsReport> {
    return runAsSystemAsync(
      'ADMIN_CONSOLE',
      'Notification decision analytics: a CROSS-TENANT roll-up over notification_decisions. It returns COUNTS and TYPE NAMES only — never a title, a body, a child id or a family id — behind InternalAdminGuard, because a suppression rate is a platform-level number and a notification body is not.',
      async () => {
        const params = [
          filter.fromBusinessDate,
          filter.toBusinessDate,
          filter.countryCode,
          filter.ageBand,
          filter.audience,
          filter.category,
        ];
        const [agg] = await this.raw().$queryRawUnsafe<any[]>(SQL_DECISION_ANALYTICS, ...params);
        const types = await this.raw().$queryRawUnsafe<any[]>(
          SQL_DECISION_TOP_TYPES,
          ...params,
          topTypesLimit,
        );

        const total = Number(agg?.total ?? 0);
        const notificationRows = Number(agg?.notification_rows ?? 0);
        const opened = Number(agg?.opened ?? 0);
        const decidedSuppress = Number(agg?.decided_suppress ?? 0);
        const outcomeSuppressed = Number(agg?.outcome_suppressed ?? 0);
        const duplicates = Number(agg?.duplicates ?? 0);
        const aiRewritten = Number(agg?.ai_rewritten ?? 0);

        // `rate` guards the denominator in ONE place. A dashboard that shows
        // `NaN%` on an empty date range is a dashboard nobody trusts afterwards.
        const rate = (numerator: number, denominator: number): number =>
          denominator === 0 ? 0 : Math.round((numerator / denominator) * 10_000) / 10_000;

        return {
          total,
          decidedSend: Number(agg?.decided_send ?? 0),
          decidedDefer: Number(agg?.decided_defer ?? 0),
          decidedSuppress,
          delivered: Number(agg?.delivered ?? 0),
          outcomeSuppressed,
          duplicates,
          fatigueBlocked: Number(agg?.fatigue_blocked ?? 0),
          deliveryFailures: Number(agg?.delivery_failures ?? 0),
          aiRewritten,
          aiFailed: Number(agg?.ai_failed ?? 0),
          opened,
          notificationRows,
          averageScore: Math.round(Number(agg?.avg_score ?? 0) * 100) / 100,
          // Suppressed by EITHER the engine or the pipeline — the number a
          // product owner means by «suppressed», which is not the same as
          // either column on its own.
          suppressionRate: rate(decidedSuppress + outcomeSuppressed, total),
          duplicateRate: rate(duplicates, total),
          aiRewriteRate: rate(aiRewritten, total),
          openRate: rate(opened, notificationRows),
          // NULL, not zero. See the port's docstring: this product cannot
          // measure «acted» today, and a fabricated zero would look like a
          // measurement.
          actionRate: null,
          topTypes: types.map((t) => ({
            type: t.type,
            total: Number(t.total),
            suppressed: Number(t.suppressed),
          })),
        };
      },
    );
  }

  /* eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types */
  private raw(): {
    $executeRawUnsafe: (sql: string, ...params: unknown[]) => Promise<number>;
    $queryRawUnsafe: <T>(sql: string, ...params: unknown[]) => Promise<T>;
  } {
    return this.prisma as any;
  }
}

/**
 * The policy settings' read/write side. Separate class, same file, because it is
 * eleven lines and a second file would be ceremony — but a separate PORT,
 * because the engine reads the policy on every decision and reads the ledger on
 * none of them, and a service should not be able to reach a decision row by
 * having asked for a cap.
 */
@Injectable()
export class PrismaNotificationPolicyRepository implements INotificationPolicyRepository {
  constructor(private readonly prisma: PrismaService) {}

  async readSettings(familyId: string): Promise<Record<string, string>> {
    const rows = await this.raw().$queryRawUnsafe<Array<{ key: string; value: string }>>(
      SQL_READ_POLICY_SETTINGS,
      familyId,
    );
    const out: Record<string, string> = {};
    for (const r of rows) out[r.key] = r.value;
    return out;
  }

  /**
   * VALIDATED BEFORE IT REACHES SQL, and it THROWS on an unknown key or an
   * out-of-bounds value — unlike the READ path, which degrades. The asymmetry is
   * deliberate and it is `GrowthSettingsService`'s: refusing a bad write is a
   * useful error message to a human who is present; refusing a bad read months
   * later would mute a household because of a bound that was tightened after the
   * row was written.
   */
  async upsertSetting(
    familyId: string,
    key: string,
    value: string,
    updatedBy: string | null,
  ): Promise<void> {
    parsePolicySetting(key, value);
    if (value.length > 200) {
      throw new NotificationPolicySettingError(`Value for "${key}" exceeds 200 characters`);
    }
    await this.raw().$executeRawUnsafe(SQL_UPSERT_POLICY_SETTING, familyId, key, value, updatedBy);
  }

  private raw(): {
    $executeRawUnsafe: (sql: string, ...params: unknown[]) => Promise<number>;
    $queryRawUnsafe: <T>(sql: string, ...params: unknown[]) => Promise<T>;
  } {
    return this.prisma as any;
  }
}
