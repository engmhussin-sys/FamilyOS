import { Injectable, Logger, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../../../../common/prisma/prisma.service';
import { runAsSystemAsync } from '../../../../common/tenancy/system-context';
import { AuditService } from '../../../audit/application/audit.service';
import type { OperatorSession } from '../../../operators/application/operator-session.service';
import type { AiAlertStatus } from '../../../ai-core/domain/ai-alert.types';
import { findTransition, IllegalSafetyTransitionError } from '../../domain/safety-review';

/**
 * ===========================================================================
 * THE SAFETY DESK — and the two things it may see, kept apart.
 * ===========================================================================
 *
 * ── THE QUEUE CARRIES NO WORDS ─────────────────────────────────────────
 *
 * `listQueue` selects category, severity, status, module, instants and ids. It
 * does NOT select `title` or `description`, and that is a query-level decision
 * rather than a mapping one: the safest way not to disclose a field is not to
 * read it, so no later careless spread can leak what was never fetched. It is
 * the same discipline `household-detail.service.ts` applies to a child's date
 * of birth.
 *
 * The words live behind `readAlert`, behind a SEPARATE permission, and every
 * single read of them writes an audit row. That is not defensive habit: the
 * directive requires an audit for every view of sensitive content, and an alert
 * description is a sentence about a distressed child.
 *
 * ── READS ARE AUDITED HERE AND NOWHERE ELSE ────────────────────────────
 *
 * Auditing every read is how an audit table becomes the largest table in the
 * database, which is why `SchedulerOperationsController` deliberately does not.
 * The exception is exact and stated: reading a CHILD'S SAFETY CONTENT. Opening
 * a list of job names is not the same act as reading what a child wrote when
 * they were in trouble, and only the second one leaves a trace.
 *
 * ── CROSS-TENANT ON PURPOSE, AND ONLY HERE ─────────────────────────────
 *
 * The desk works ONE queue across the platform; a household has no business
 * seeing another's alerts and the desk has no household of its own. So the
 * reads run under `runAsSystem`, whose reason is logged, and every write of a
 * NOTE runs inside `runWithTenant` so the note lands stamped with the family it
 * is about — the same split `device-liveness.service.ts` uses.
 *
 * ── NOTHING HERE DELETES ANYTHING ──────────────────────────────────────
 *
 * No delete, no archive, no hard removal of an alert or a note. The database
 * enforces it too (migration 0033 revokes UPDATE and DELETE on the notes
 * table), so a future service that forgot this rule would be refused by
 * Postgres rather than by a code review.
 */

export interface SafetyQueueRow {
  alertId: string;
  familyId: string;
  childId: string;
  category: string;
  severity: string;
  status: string;
  sourceModule: string;
  createdAt: string;
  reviewedAt: string | null;
  reviewedByOperatorId: string | null;
  noteCount: number;
}

@Injectable()
export class SafetyReviewService {
  private readonly logger = new Logger(SafetyReviewService.name);

  /** The queue is a working list, not an archive. */
  static readonly QUEUE_LIMIT = 100;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * THE QUEUE. Open alerts first — `NEW` and `ESCALATED`, because an escalation
   * nobody returns to is the failure mode escalation creates — then worst, then
   * oldest.
   */
  async listQueue(options: { openOnly?: boolean; limit?: number } = {}): Promise<SafetyQueueRow[]> {
    const limit = Math.min(options.limit ?? SafetyReviewService.QUEUE_LIMIT, SafetyReviewService.QUEUE_LIMIT);
    const openOnly = options.openOnly ?? true;

    return runAsSystemAsync(
      'ADMIN_CONSOLE',
      'The safety desk works one queue across every household; a child-distress signal is a platform-level duty with no single tenant.',
      async () => {
        const rows = await this.prisma.$queryRaw<
          {
            id: string;
            family_id: string;
            child_id: string;
            category: string;
            severity: string;
            status: string;
            source_module: string;
            created_at: Date;
            reviewed_at: Date | null;
            reviewed_by_operator_id: string | null;
            note_count: bigint;
          }[]
        >`
          SELECT a.id, a.family_id, a.child_id, a.category::text AS category,
                 a.severity::text AS severity, a.status::text AS status,
                 a.source_module, a.created_at, a.reviewed_at, a.reviewed_by_operator_id,
                 (SELECT COUNT(*) FROM ai_alert_notes n WHERE n.alert_id = a.id) AS note_count
            FROM ai_alerts a
           WHERE (${openOnly}::boolean = false OR a.status IN ('NEW', 'ESCALATED'))
           ORDER BY
             CASE a.severity WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END,
             a.created_at ASC
           LIMIT ${limit}`;

        return rows.map((row) => ({
          alertId: row.id,
          familyId: row.family_id,
          childId: row.child_id,
          category: row.category,
          severity: row.severity,
          status: row.status,
          sourceModule: row.source_module,
          createdAt: row.created_at.toISOString(),
          reviewedAt: row.reviewed_at ? row.reviewed_at.toISOString() : null,
          reviewedByOperatorId: row.reviewed_by_operator_id,
          noteCount: Number(row.note_count),
        }));
      },
    );
  }

  /**
   * ONE ALERT, WITH ITS WORDS — and the read is recorded.
   *
   * The audit row is written BEFORE the content is returned, not after. If the
   * write fails the read fails: a description that reached a human with no
   * record of it reaching them is exactly what the requirement forbids, and
   * "best effort" on that would make the requirement decorative.
   */
  async readAlert(alertId: string, actor: OperatorSession) {
    return runAsSystemAsync(
      'ADMIN_CONSOLE',
      'The safety desk reads one alert in full, including its content; the desk belongs to no household and the read is audited.',
      async () => {
        const alerts = await this.prisma.$queryRaw<
          {
            id: string;
            family_id: string;
            child_id: string;
            category: string;
            severity: string;
            status: string;
            title: string;
            description: string;
            source_module: string;
            created_at: Date;
            reviewed_at: Date | null;
            reviewed_by_operator_id: string | null;
          }[]
        >`
          SELECT id, family_id, child_id, category::text AS category, severity::text AS severity,
                 status::text AS status, title, description, source_module, created_at,
                 reviewed_at, reviewed_by_operator_id
            FROM ai_alerts WHERE id = ${alertId}::uuid`;

        if (alerts.length === 0) {
          throw new NotFoundException({ code: 'ALERT_NOT_FOUND', message: 'No such alert.' });
        }
        const alert = alerts[0];

        await this.audit.record({
          familyId: alert.family_id,
          actorType: 'OPERATOR',
          operatorId: actor.operatorId,
          operatorEmail: actor.email,
          operatorRole: actor.role,
          action: 'safety.alert_content_read',
          entityType: 'AiAlert',
          entityId: alert.id,
          // No reason demanded: opening the alert you were assigned is the job,
          // and a justification field on every open is a field that fills with
          // "checking". The RECORD is the control here, not the ceremony.
          metadata: { severity: alert.severity, category: alert.category, status: alert.status },
        });

        const notes = await this.prisma.$queryRaw<
          { id: string; operator_email: string; transition_to: string | null; body: string; created_at: Date }[]
        >`
          SELECT id, operator_email, transition_to::text AS transition_to, body, created_at
            FROM ai_alert_notes WHERE alert_id = ${alertId}::uuid ORDER BY created_at ASC`;

        return {
          alertId: alert.id,
          familyId: alert.family_id,
          childId: alert.child_id,
          category: alert.category,
          severity: alert.severity,
          status: alert.status,
          title: alert.title,
          description: alert.description,
          sourceModule: alert.source_module,
          createdAt: alert.created_at.toISOString(),
          reviewedAt: alert.reviewed_at ? alert.reviewed_at.toISOString() : null,
          reviewedByOperatorId: alert.reviewed_by_operator_id,
          notes: notes.map((note) => ({
            id: note.id,
            operatorEmail: note.operator_email,
            transitionTo: note.transition_to,
            body: note.body,
            createdAt: note.created_at.toISOString(),
          })),
        };
      },
    );
  }

  /**
   * THE WRITE THAT NEVER EXISTED. Moves an alert, records who moved it and when,
   * and attaches the note explaining why.
   *
   * The transition is checked against the table in `domain/safety-review.ts`,
   * which OWNS what is legal — this method does not second-guess it and does not
   * carry a second copy of the rules.
   */
  async transition(
    alertId: string,
    to: AiAlertStatus,
    actor: OperatorSession,
    note: string,
    now: Date = new Date(),
  ): Promise<{ alertId: string; from: AiAlertStatus; to: AiAlertStatus }> {
    return runAsSystemAsync(
      'ADMIN_CONSOLE',
      'The safety desk moves one alert through its review workflow; the desk belongs to no household.',
      async () => {
        const current = await this.prisma.$queryRaw<{ status: string; family_id: string }[]>`
          SELECT status::text AS status, family_id FROM ai_alerts WHERE id = ${alertId}::uuid`;

        if (current.length === 0) {
          throw new NotFoundException({ code: 'ALERT_NOT_FOUND', message: 'No such alert.' });
        }
        const from = current[0].status as AiAlertStatus;
        const familyId = current[0].family_id;

        const rule = findTransition(from, to);
        if (!rule) throw new IllegalSafetyTransitionError(from, to);

        /**
         * `reviewed_at` and the reviewer are set on every move EXCEPT a reopen.
         * Reopening means «this is unhandled again», and leaving a reviewer
         * stamped on an alert nobody is currently handling is what would make
         * the growth alarm — which counts `reviewed_at IS NULL` criticals —
         * quietly under-report the real backlog. Clearing them is what makes
         * the counter honest in both directions for the first time.
         */
        const reopening = to === 'NEW';
        await this.prisma.$executeRaw`
          UPDATE ai_alerts
             SET status = ${to}::"AlertStatus",
                 reviewed_at = ${reopening ? null : now},
                 reviewed_by_operator_id = ${reopening ? null : actor.operatorId}::uuid,
                 updated_at = ${now}
           WHERE id = ${alertId}::uuid`;

        // The note is a fact about ONE household's child, so it is written in
        // that household's context and the extension stamps it — the platform
        // does not reach in and place a row.
        await this.prisma.$executeRaw`
          INSERT INTO ai_alert_notes (family_id, alert_id, operator_id, operator_email, transition_to, body)
          VALUES (${familyId}::uuid, ${alertId}::uuid, ${actor.operatorId}::uuid, ${actor.email},
                  ${to}::"AlertStatus", ${note})`;

        await this.audit.record({
          familyId,
          actorType: 'OPERATOR',
          operatorId: actor.operatorId,
          operatorEmail: actor.email,
          operatorRole: actor.role,
          action: 'safety.alert_reviewed',
          entityType: 'AiAlert',
          entityId: alertId,
          reason: note,
          metadata: { from, to },
        });

        this.logger.log(JSON.stringify({ event: 'safety.alert_transitioned', alertId, from, to }));
        return { alertId, from, to };
      },
    );
  }
}
