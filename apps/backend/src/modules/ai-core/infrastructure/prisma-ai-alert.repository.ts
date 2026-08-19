import { Injectable, Logger } from '@nestjs/common';
import type { AlertCategory, AlertSeverity, AlertStatus } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { tenantIdForWrite } from '../../../common/tenancy/tenant-context';
import type {
  AiAlertCategory,
  AiAlertSeverity,
  AiAlertStatus,
  IAiAlertRepository,
  IAiAlertView,
  IRecordAiAlertInput,
} from '../domain/ai-alert.types';

/**
 * THE COMPILE-TIME BRIDGE between the ORM-free domain unions and the generated
 * Prisma enums. Nothing calls these; they exist so that a member added to or
 * removed from `AlertCategory` / `AlertSeverity` / `AlertStatus` in
 * `schema.prisma` breaks `tsc` HERE — at one named line with this comment above
 * it — instead of at runtime on an insert, or silently in a `where` clause that
 * quietly matches nothing.
 */
const _categoryIsExhaustive: AlertCategory = 'HEALTH' satisfies AiAlertCategory;
const _severityIsExhaustive: AlertSeverity = 'CRITICAL' satisfies AiAlertSeverity;
const _statusIsExhaustive: AlertStatus = 'NEW' satisfies AiAlertStatus;
void _categoryIsExhaustive;
void _severityIsExhaustive;
void _statusIsExhaustive;

/**
 * ============================================================================
 * THE ONE WRITER OF `ai_alerts`.
 * ============================================================================
 *
 * The table's schema comment is its contract — «parents see alerts, never raw
 * monitored content» — and this class is where that contract is either kept or
 * broken, so it is kept in one place. Note what this file does NOT have: any
 * parameter, column or code path for the text that caused a detection.
 * `IRecordAiAlertInput` cannot express it, so this repository cannot store it.
 *
 * IDEMPOTENCY IS `ai_alerts (family_id, source_event_id)` UNIQUE — migration
 * 0027 — AND NOTHING ELSE. There is deliberately no `findFirst` before the
 * insert: a check-then-insert cannot see a concurrent writer and would let two
 * replicas handling one replayed check-in alert a parent twice. P2002 on this
 * table means exactly one thing — this detection has already produced its alert
 * for this family — and that is a success, reported as «not written» and never
 * thrown. Any other error is a real failure and is rethrown, because a
 * swallowed error here is a child-safety alert that silently did not happen.
 * Same shape, and the same reasoning, as `PrismaRuntimeAlertRepository`.
 */
@Injectable()
export class PrismaAiAlertRepository implements IAiAlertRepository {
  private readonly logger = new Logger(PrismaAiAlertRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(input: IRecordAiAlertInput): Promise<boolean> {
    try {
      await this.prisma.aiAlert.create({
        data: {
          // THE SERVER'S OWN TENANT, from the ambient request context — never a
          // familyId that travelled in from a device.
          familyId: tenantIdForWrite(),
          childId: input.childId,
          category: input.category as AlertCategory,
          severity: input.severity as AlertSeverity,
          title: input.title,
          description: input.description,
          sourceModule: input.sourceModule,
          sourceEventId: input.sourceEventId,
          // `status` is left to the schema default `NEW`, `reviewed_at` and
          // `reviewed_by_user_id` to NULL, and all three are the CONSIDERED
          // values rather than the convenient ones: nobody has reviewed this
          // alert, and `GrowthAlertsService.aiSafetyIncident` keys on exactly
          // that — `reviewed_at IS NULL` is what makes an incident count as
          // outstanding.
        },
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        // The same detection, replayed. The database refused it; the first
        // alert already reached the parent.
        return false;
      }
      throw err;
    }
    return true;
  }

  async listForFamily(familyId: string, limit: number): Promise<IAiAlertView[]> {
    const rows = await this.prisma.aiAlert.findMany({
      where: { familyId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      // THE COLUMN LIST IS THE PAYLOAD, and it is spelled out rather than
      // spread: `source_event_id` is the server's dedupe key and must not leave
      // the server, and a `select` that enumerates is the only version of this
      // query that stays safe when a column is added to the model tomorrow.
      select: {
        id: true,
        childId: true,
        category: true,
        severity: true,
        status: true,
        title: true,
        description: true,
        sourceModule: true,
        createdAt: true,
        child: { select: { firstName: true } },
      },
    });

    return rows.map((row) => ({
      id: row.id,
      childId: row.childId,
      childFirstName: row.child.firstName,
      category: row.category as AiAlertCategory,
      severity: row.severity as AiAlertSeverity,
      status: row.status as AiAlertStatus,
      title: row.title,
      description: row.description,
      sourceModule: row.sourceModule,
      createdAt: row.createdAt,
    }));
  }
}
