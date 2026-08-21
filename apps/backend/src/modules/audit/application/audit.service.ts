import { Injectable } from '@nestjs/common';

import type { OperatorRole, Prisma } from '@prisma/client';
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
  /**
   * SPRINT F2. `OPERATOR` joined the union, and it is the value that makes the
   * question «which of my staff did this» answerable. Until now every operator
   * action was recorded as `SYSTEM` — the same value a scheduled sweep uses —
   * so a support agent's suspension and a nightly retention delete were
   * indistinguishable in the one table a compliance review reads.
   */
  actorType: 'USER' | 'DEVICE' | 'SYSTEM' | 'OPERATOR';
  actorUserId?: string;
  /**
   * The three operator fields travel TOGETHER or not at all, and the service
   * refuses a row that carries some of them (see `record`). A row that names an
   * operator id with no email is a row that stops being readable the moment
   * that operator is renamed.
   *
   * The email and the role are DENORMALISED ON PURPOSE: an operator can be
   * renamed, re-roled or revoked, and this row must record who they WERE and
   * what they HELD when they acted. Joining `operators` for that answer would
   * silently rewrite history on every role change.
   */
  operatorId?: string;
  operatorEmail?: string;
  operatorRole?: OperatorRole;
  /**
   * WHY. Required for every operator MUTATION — enforced here rather than by a
   * NOT NULL, because this same table stores `auth.login`, which has no reason
   * and must not be made to invent one.
   */
  reason?: string;
  /** Correlates this row with the request that produced it. */
  requestId?: string;
  action: string;
  entityType: string;
  entityId: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
}

/**
 * The operator actions that MUST carry a reason. Reads are absent on purpose:
 * auditing a read is right, but demanding a justification for opening a list is
 * how a required field becomes a field everyone types «x» into.
 */
const OPERATOR_ACTIONS_REQUIRING_REASON = /^operator\.(revoked|updated)$/;

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
    /**
     * TWO REFUSALS, BOTH ABOUT ROWS THAT WOULD BE UNREADABLE LATER.
     *
     * A partial operator identity is worse than none: `operator_id` alone is a
     * uuid that stops resolving the moment that person is removed, and the
     * denormalised email exists precisely so the row survives them.
     *
     * And an operator MUTATION with no reason is the row a compliance review
     * opens and finds empty. Both throw rather than warn, because an audit
     * service that quietly writes a defective row is worse than one that
     * refuses — the defect is only discovered when the row is needed.
     */
    const operatorFields = [input.operatorId, input.operatorEmail, input.operatorRole];
    const present = operatorFields.filter((value) => value !== undefined && value !== null).length;
    if (present !== 0 && present !== operatorFields.length) {
      throw new Error(
        'AUDIT_PARTIAL_OPERATOR_IDENTITY: operatorId, operatorEmail and operatorRole must be written together.',
      );
    }
    if (input.actorType === 'OPERATOR' && present === 0) {
      throw new Error('AUDIT_OPERATOR_WITHOUT_IDENTITY: actorType OPERATOR requires the operator identity.');
    }
    if (OPERATOR_ACTIONS_REQUIRING_REASON.test(input.action) && !input.reason?.trim()) {
      throw new Error(`AUDIT_REASON_REQUIRED: ${input.action} must carry a reason.`);
    }

    await this.prisma.auditLog.create({
      data: {
        familyId: input.familyId,
        actorType: input.actorType,
        actorUserId: input.actorUserId,
        operatorId: input.operatorId,
        operatorEmail: input.operatorEmail,
        operatorRole: input.operatorRole,
        reason: input.reason,
        requestId: input.requestId,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        metadata: input.metadata as Prisma.InputJsonValue | undefined,
        ipAddress: input.ipAddress,
      },
    });
  }
}
