import { ConflictException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import type { OperatorRole } from '@prisma/client';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { runAsSystemAsync } from '../../../common/tenancy/system-context';
import { PasswordService } from '../../auth/application/services/password.service';
import { AuditService } from '../../audit/application/audit.service';
import { OperatorSessionService, type OperatorSession } from './operator-session.service';

/**
 * ===========================================================================
 * STAFF, AND THE THREE MOMENTS THAT MATTER.
 * ===========================================================================
 *
 * SIGNING IN, SIGNING OUT, AND CEASING TO BE STAFF. Everything else an operator
 * console needs is a read.
 *
 * ── EVERY REFUSAL COSTS THE SAME ───────────────────────────────────────
 *
 * An unknown email, a wrong password, a suspended account and a revoked one all
 * produce ONE 401 with one message AND all perform the argon2 verification.
 * Returning early on «no such operator» would turn this route into an email
 * oracle: a fast refusal means the address is unknown, a slow one means it is
 * real. `PasswordService.verify` against a known-bad hash costs what a real
 * verification costs, which is the point.
 *
 * ── A SUSPENSION TAKES EFFECT NOW, NOT AT EXPIRY ───────────────────────
 *
 * Every status change and every role change calls `sessions.revokeAll` in the
 * same operation. This is the property a JWT could not have given us and the
 * reason the session store is server-side: «remove this person's access» has to
 * mean the NEXT request, not the next eight hours.
 *
 * ── WHY THESE WRITES RUN `runAsSystem` ─────────────────────────────────
 *
 * `operators` is a GLOBAL model — staff belong to no household — and the audit
 * rows written here are deliberately tenant-less for the same reason. An
 * operator being created is a fact about the platform, and stamping some
 * family onto it would be a lie about who it affected.
 */
@Injectable()
export class OperatorService {
  private readonly logger = new Logger(OperatorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly sessions: OperatorSessionService,
    private readonly audit: AuditService,
  ) {}

  /**
   * A hash of a password nobody has. Verified against when the email is
   * unknown, so the refusal costs the same as a real one. Generated once at
   * module load rather than per request.
   */
  private decoyHash: string | null = null;

  private async decoy(): Promise<string> {
    this.decoyHash ??= await this.passwords.hash(`decoy-${Math.random()}-${Date.now()}`);
    return this.decoyHash;
  }

  /** Emails are compared lowercased, so a login cannot be case-shadowed. */
  private static normalise(email: string): string {
    return email.trim().toLowerCase();
  }

  async signIn(email: string, password: string, ipAddress?: string): Promise<{ token: string; session: OperatorSession }> {
    const normalised = OperatorService.normalise(email);

    return runAsSystemAsync(
      'ADMIN_CONSOLE',
      'Operator sign-in resolves a member of platform staff by email; operators belong to no household and there is no tenant to scope by.',
      async () => {
        const operator = await this.prisma.operator.findUnique({ where: { email: normalised } });

        // ALWAYS verify, even with no operator — see the header.
        const hash = operator?.passwordHash ?? (await this.decoy());
        const ok = await this.passwords.verify(hash, password);

        if (!operator || !ok || operator.status !== 'ACTIVE') {
          this.logger.warn(
            JSON.stringify({
              event: 'operator.sign_in_refused',
              email: normalised,
              // The distinction is kept HERE and never in the response.
              cause: !operator ? 'UNKNOWN' : !ok ? 'BAD_PASSWORD' : operator.status,
            }),
          );
          throw OperatorService.refusal();
        }

        const session: Omit<OperatorSession, 'issuedAt'> = {
          operatorId: operator.id,
          email: operator.email,
          role: operator.role,
        };
        const token = await this.sessions.open(session);

        await this.prisma.operator.update({
          where: { id: operator.id },
          data: { lastLoginAt: new Date() },
        });

        await this.audit.record({
          actorType: 'OPERATOR',
          operatorId: operator.id,
          operatorEmail: operator.email,
          operatorRole: operator.role,
          action: 'operator.signed_in',
          entityType: 'Operator',
          entityId: operator.id,
          ipAddress,
        });

        return { token, session: { ...session, issuedAt: new Date().toISOString() } };
      },
    );
  }

  /**
   * THE BOOTSTRAP, AND THE ONLY WAY THE FIRST OPERATOR CAN EXIST.
   *
   * It is a genuine problem rather than a formality: `create` below requires an
   * acting operator, and on a fresh deployment there is none. The three usual
   * answers were considered and two were rejected outright.
   *
   *   A SEEDED DEFAULT CREDENTIAL in a migration — refused. A password that
   *   ships in a repository is a password that is in production forever, and
   *   this one would open the whole operator console.
   *   A PERMANENT «CREATE ADMIN» ROUTE — refused. It is a privilege-escalation
   *   endpoint that stays reachable for the life of the deployment.
   *
   * WHAT THIS DOES INSTEAD: it refuses the moment ANY operator row exists. The
   * window in which it works is the window between the first migration and the
   * first operator, it closes permanently and by itself, and it cannot be
   * reopened except by emptying the table — which is a database action, not an
   * API one. The caller must still hold the shared platform key, which the
   * person doing the deployment already has and nobody else does.
   */
  async bootstrapFirstOperator(input: {
    email: string;
    fullName: string;
    password: string;
  }): Promise<{ id: string; email: string }> {
    return runAsSystemAsync(
      'ADMIN_CONSOLE',
      'Creates the first platform operator on a deployment that has none; operators belong to no household.',
      async () => {
        const existing = await this.prisma.operator.count();
        if (existing > 0) {
          throw new ConflictException({
            code: 'OPERATORS_ALREADY_EXIST',
            message: 'This deployment already has operators. Use the managed create path.',
          });
        }

        const created = await this.prisma.operator.create({
          data: {
            email: OperatorService.normalise(input.email),
            fullName: input.fullName,
            role: 'SUPER_ADMIN',
            passwordHash: await this.passwords.hash(input.password),
          },
        });

        // Audited as itself, not as a normal create: «the console was opened
        // for the first time, by whoever held the deployment key» is a distinct
        // and rare fact, and a reviewer should be able to find it by name.
        await this.audit.record({
          actorType: 'OPERATOR',
          operatorId: created.id,
          operatorEmail: created.email,
          operatorRole: created.role,
          action: 'operator.bootstrapped',
          entityType: 'Operator',
          entityId: created.id,
          reason: 'First operator on a deployment that had none.',
        });

        this.logger.warn(JSON.stringify({ event: 'operator.bootstrapped', email: created.email }));
        return { id: created.id, email: created.email };
      },
    );
  }

  /** The ordinary path, once somebody exists to do it. */
  async create(
    input: { email: string; fullName: string; password: string; role: OperatorRole },
    actor: OperatorSession,
    reason: string,
  ): Promise<{ id: string; email: string }> {
    return runAsSystemAsync(
      'ADMIN_CONSOLE',
      'A platform operator creates another operator; operators belong to no household.',
      async () => {
        const created = await this.prisma.operator.create({
          data: {
            email: OperatorService.normalise(input.email),
            fullName: input.fullName,
            role: input.role,
            passwordHash: await this.passwords.hash(input.password),
          },
        });

        await this.audit.record({
          actorType: 'OPERATOR',
          operatorId: actor.operatorId,
          operatorEmail: actor.email,
          operatorRole: actor.role,
          action: 'operator.created',
          entityType: 'Operator',
          entityId: created.id,
          reason,
          metadata: { email: created.email, role: created.role },
        });

        return { id: created.id, email: created.email };
      },
    );
  }

  async signOut(token: string, session: OperatorSession): Promise<void> {
    await this.sessions.close(token);
    await runAsSystemAsync(
      'ADMIN_CONSOLE',
      'Operator sign-out records a platform-staff event that belongs to no household.',
      () =>
        this.audit.record({
          actorType: 'OPERATOR',
          operatorId: session.operatorId,
          operatorEmail: session.email,
          operatorRole: session.role,
          action: 'operator.signed_out',
          entityType: 'Operator',
          entityId: session.operatorId,
        }),
    );
  }

  /**
   * Status and role are changed through ONE method, because both invalidate
   * every live session and splitting them is how one of the two paths forgets.
   */
  async update(
    targetId: string,
    changes: { role?: OperatorRole; status?: 'ACTIVE' | 'SUSPENDED' | 'REVOKED' },
    actor: OperatorSession,
    reason: string,
  ): Promise<{ id: string; sessionsKilled: number }> {
    return runAsSystemAsync(
      'ADMIN_CONSOLE',
      'A platform operator changes another operator\'s role or status; operators belong to no household.',
      async () => {
        const previous = await this.prisma.operator.findUnique({ where: { id: targetId } });
        if (!previous) throw OperatorService.refusal();

        await this.prisma.operator.update({
          where: { id: targetId },
          data: {
            ...(changes.role ? { role: changes.role } : {}),
            ...(changes.status ? { status: changes.status } : {}),
            // A tombstone, set once. Revocation is a fact an audit trail keeps.
            ...(changes.status === 'REVOKED' && !previous.revokedAt ? { revokedAt: new Date() } : {}),
          },
        });

        // BEFORE the response, not after: the window in which a suspended
        // operator still holds a working session must not exist.
        const sessionsKilled = await this.sessions.revokeAll(targetId);

        await this.audit.record({
          actorType: 'OPERATOR',
          operatorId: actor.operatorId,
          operatorEmail: actor.email,
          operatorRole: actor.role,
          action: changes.status === 'REVOKED' ? 'operator.revoked' : 'operator.updated',
          entityType: 'Operator',
          entityId: targetId,
          reason,
          metadata: {
            // What it WAS, so the change is reversible by reading rather than
            // by remembering — the same rule the plan catalogue follows.
            previous: { role: previous.role, status: previous.status },
            next: { role: changes.role ?? previous.role, status: changes.status ?? previous.status },
            sessionsKilled,
          },
        });

        return { id: targetId, sessionsKilled };
      },
    );
  }

  /** One refusal, one shape, for every cause. */
  private static refusal(): UnauthorizedException {
    return new UnauthorizedException({
      code: 'OPERATOR_UNAUTHORIZED',
      message: 'Operator authentication failed.',
      messageAr: 'تعذّر التحقّق من هوية المشغّل.',
    });
  }
}
