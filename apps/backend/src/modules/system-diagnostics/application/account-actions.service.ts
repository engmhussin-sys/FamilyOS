import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';

import { AuditService } from '../../audit/application/audit.service';
import { PrismaService } from '../../../common/prisma/prisma.service';

/**
 * ===========================================================================
 * THE ACTIONS AN OWNER MUST BE ABLE TO TAKE ON AN ACCOUNT.
 * ===========================================================================
 *
 * The accounts console could SHOW that a user is `ACTIVE`, `SUSPENDED` or
 * `PENDING_VERIFICATION` and could not change any of it. A status displayed and
 * not actionable is a status somebody eventually changes in a SQL console —
 * untraceable, and afterwards indistinguishable from a change the product made.
 *
 * ============================ WHAT SUSPENSION IS ===========================
 *
 * `users.status = 'SUSPENDED'`. It is a REVERSIBLE flag, not a deletion: no row
 * is removed, no family is touched, no child loses anything, and reactivating
 * restores exactly the state before. Account deletion already exists as its own
 * module with its own retention rules and is deliberately NOT reachable from
 * here — a console where "suspend" and "erase" sit side by side is a console
 * where the wrong one gets clicked.
 *
 * DELETED IS A TERMINAL STATE AND THIS SERVICE REFUSES IT. A user whose
 * deletion has been processed must not be quietly resurrected by an operator
 * clicking reactivate; that would undo a retention decision made under a policy
 * this service knows nothing about.
 *
 * EVERY ACTION WRITES AN AUDIT ROW with the operator's stated reason, tied to
 * the household. `actorType: 'SYSTEM'` is honest — the platform operator is not
 * a `users` row, and `InternalAdminGuard` deliberately writes no `request.user`.
 */
@Injectable()
export class AccountActionsService {
  private readonly logger = new Logger(AccountActionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async setStatus(input: {
    userId: string;
    /** `ACTIVE` means RESTORE what suspension replaced — see below. */
    status: 'ACTIVE' | 'SUSPENDED';
    reason: string;
  }): Promise<{ userId: string; familyId: string | null; from: string; to: string }> {
    const rows = await this.prisma.$queryRaw<{ id: string; status: string; family_id: string | null }[]>`
      SELECT u.id, u.status::text AS status,
             (SELECT fm.family_id FROM family_members fm
               WHERE fm.user_id = u.id AND fm.deleted_at IS NULL
               ORDER BY (fm.role = 'OWNER') DESC, fm.joined_at ASC LIMIT 1) AS family_id
        FROM users u WHERE u.id = ${input.userId}::uuid`;

    if (rows.length === 0) {
      throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'No such user.' });
    }
    const user = rows[0];

    if (user.status === 'DELETED') {
      throw new BadRequestException({
        code: 'USER_DELETED',
        message:
          'This account has been deleted. Reactivating it here would undo a retention decision made elsewhere; use the account-deletion module.',
      });
    }

    /**
     * ================= REACTIVATION RESTORES, IT DOES NOT SET =================
     *
     * A newly registered user is `PENDING_VERIFICATION`, not `ACTIVE` — measured
     * the first time this suite ran. So an operator who suspends a
     * not-yet-verified account and later "reactivates" it would, with a naive
     * `status = 'ACTIVE'`, have MARKED AN UNVERIFIED EMAIL AS VERIFIED with a
     * support click. Nothing would report it, and the verification flow that
     * owns that transition would never have run.
     *
     * So reactivation restores what suspension replaced, read from the audit row
     * suspension itself wrote. If there is no such row this service does not
     * guess: it refuses, because "restore" with nothing to restore from is
     * indistinguishable from "set to ACTIVE and hope".
     */
    let target = input.status as string;
    if (input.status === 'ACTIVE') {
      if (user.status !== 'SUSPENDED') {
        return { userId: user.id, familyId: user.family_id, from: user.status, to: user.status };
      }
      const previous = await this.prisma.$queryRaw<{ metadata: { from?: string } | null }[]>`
        SELECT metadata FROM audit_logs
         WHERE entity_type = 'user' AND entity_id = ${input.userId}::uuid
           AND action = 'account.operator_suspended'
         ORDER BY created_at DESC LIMIT 1`;
      const restored = previous[0]?.metadata?.from;
      if (!restored || restored === 'SUSPENDED' || restored === 'DELETED') {
        throw new BadRequestException({
          code: 'NO_STATUS_TO_RESTORE',
          message:
            'This account was not suspended by this console, so there is no recorded status to restore. Reactivating it would be a guess.',
        });
      }
      target = restored;
    }

    if (user.status === target) {
      // Not an error, and not a silent no-op either: the operator is told the
      // status was already what they asked for, which is different from
      // "changed" and matters when two people are working the same ticket.
      return { userId: user.id, familyId: user.family_id, from: user.status, to: target };
    }

    await this.prisma.$executeRawUnsafe(
      `UPDATE users SET status = $1::"UserStatus", updated_at = now() WHERE id = $2::uuid`,
      target,
      input.userId,
    );

    await this.audit.record({
      familyId: user.family_id ?? undefined,
      actorType: 'SYSTEM',
      action: input.status === 'SUSPENDED' ? 'account.operator_suspended' : 'account.operator_reactivated',
      entityType: 'user',
      entityId: user.id,
      metadata: { from: user.status, to: target, reason: input.reason },
    });

    this.logger.warn(
      `OPERATOR ACCOUNT ACTION: user ${user.id} ${user.status} -> ${target}. Reason: ${input.reason}`,
    );

    return { userId: user.id, familyId: user.family_id, from: user.status, to: target };
  }
}
