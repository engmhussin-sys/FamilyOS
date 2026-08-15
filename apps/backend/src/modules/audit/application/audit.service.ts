import { Injectable } from '@nestjs/common';

import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';

export interface IRecordAuditEventInput {
  /**
   * PHASE C (PC-S-006). The family this event belongs to, for the callers that
   * run WITHOUT an ambient tenant.
   *
   * Under a normal request the tenant extension stamps `familyId` from the
   * verified token and this field is unnecessary — pass nothing. But the whole
   * `/auth/*` surface is `@SystemRoute('AUTH_BOOTSTRAP')`, because login runs
   * before any family context can exist; under a SystemContext the extension
   * passes writes through UNTOUCHED, so `auth.login`, `auth.register`,
   * `auth.logout` and `auth.refresh_reuse_detected` were all landing with
   * `family_id IS NULL`. Measured on the verify database before the fix: 202
   * login rows and 184 register rows, zero of them tenant-scoped.
   *
   * That is the trail a custody dispute actually needs — "who signed into this
   * family's account, and when" — and it could not be produced per-family.
   * A1 (BA-009) found the column missing entirely and F2 added it; this closes
   * the last set of writers that were not using it.
   *
   * It is SERVER-DERIVED at every call site (from the resolved membership or a
   * verified token claim), never from a request body. `tenantIdForWrite`'s rule
   * still holds: under a TENANT context a conflicting explicit id is a
   * cross-tenant write and throws.
   */
  familyId?: string;
  actorType: 'USER' | 'DEVICE' | 'SYSTEM';
  actorUserId?: string;
  action: string;
  entityType: string;
  entityId: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
}

/**
 * Sprint 9's Audit Completeness finding, made real: `AuditLog` was
 * designed in Phase 1 (schema.prisma) but had ZERO call sites anywhere
 * in the codebase \u2014 confirmed via a full-codebase grep before writing
 * this class. This service is the first real writer to that table.
 *
 * Deliberately NOT the audit mechanism for every category the reviewer
 * listed \u2014 two categories already have their own specialized,
 * append-only audit trail and are NOT duplicated here:
 *   - Pairing/Device Removal/Runtime Enforcement \u2192 `DevicePairingEvent`
 *     (Decision-059: "no transition without audit," already enforced)
 *   - AI Decisions \u2192 `AiMemoryEntry`'s RECOMMENDATION category
 *     (Sprint 8's Decision History, already the full explainable record)
 * Writing the SAME event to both `AuditLog` and one of those tables
 * would create two audit trails that could drift out of sync \u2014 worse
 * than one trail per domain. `AuditLog` is now wired for the categories
 * that had NO existing trail: Login/Logout, Policy Change, Billing.
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(input: IRecordAuditEventInput): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        familyId: input.familyId,
        actorType: input.actorType,
        actorUserId: input.actorUserId,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        metadata: input.metadata as Prisma.InputJsonValue | undefined,
        ipAddress: input.ipAddress,
      },
    });
  }
}
