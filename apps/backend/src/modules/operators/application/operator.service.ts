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
        // Hashed BEFORE the transaction opens. Argon2 is deliberately slow, and
        // holding a SERIALIZABLE transaction open for the length of a password
        // hash is holding it open for the one thing in here that is not a
        // database operation.
        const passwordHash = await this.passwords.hash(input.password);

        const created = await this.prisma.$transaction(
          async (tx) => {
            /**
             * COUNT-THEN-CREATE IS A RACE, AND THIS IS THE ONE PLACE IT MATTERS.
             * Two requests arriving together with DIFFERENT emails both read
             * zero and both create a SUPER_ADMIN — the unique index on `email`
             * does not catch it, because the emails differ. On the one route
             * that mints unrestricted access to a console over children's data,
             * «probably only one» is not a property worth having.
             *
             * SERIALIZABLE makes the read part of the transaction's snapshot, so
             * Postgres aborts the loser with a serialization failure and exactly
             * one bootstrap survives. It is the correct isolation level here and
             * an expensive one nearly everywhere else — which is why it appears
             * on this method and no other.
             */
            const existing = await tx.operator.count();
            if (existing > 0) {
              throw new ConflictException({
                code: 'OPERATORS_ALREADY_EXIST',
                message: 'This deployment already has operators. Use the managed create path.',
              });
            }

            const row = await tx.operator.create({
              data: {
                email: OperatorService.normalise(input.email),
                fullName: input.fullName,
                role: 'SUPER_ADMIN',
                passwordHash,
              },
            });

            // Audited as itself, not as a normal create: «the console was opened
            // for the first time, by whoever held the deployment key» is a
            // distinct and rare fact, and a reviewer should find it by name.
            // In the SAME transaction, so the first operator cannot exist
            // without the row that says how they came to.
            await this.audit.record(
              {
                actorType: 'OPERATOR',
                operatorId: row.id,
                operatorEmail: row.email,
                operatorRole: row.role,
                action: 'operator.bootstrapped',
                entityType: 'Operator',
                entityId: row.id,
                reason: 'First operator on a deployment that had none.',
              },
              tx,
            );

            return row;
          },
          { isolationLevel: 'Serializable' },
        );

        this.logger.warn(JSON.stringify({ event: 'operator.bootstrapped', email: created.email }));
        return { id: created.id, email: created.email };
      },
    );
  }

  /**
   * THE STAFF DIRECTORY. Never returns `passwordHash`, and the field list is
   * written out rather than spread: a `select` that names its columns cannot
   * start leaking a column somebody adds to the model later.
   */
  async list(): Promise<
    {
      id: string;
      email: string;
      fullName: string;
      role: OperatorRole;
      status: string;
      lastLoginAt: string | null;
      revokedAt: string | null;
      createdAt: string;
    }[]
  > {
    return runAsSystemAsync(
      'ADMIN_CONSOLE',
      'The staff directory lists platform operators; operators belong to no household.',
      async () => {
        const rows = await this.prisma.operator.findMany({
          select: {
            id: true,
            email: true,
            fullName: true,
            role: true,
            status: true,
            lastLoginAt: true,
            revokedAt: true,
            createdAt: true,
          },
          orderBy: [{ status: 'asc' }, { email: 'asc' }],
        });

        return rows.map((row) => ({
          id: row.id,
          email: row.email,
          fullName: row.fullName,
          role: row.role,
          status: row.status,
          lastLoginAt: row.lastLoginAt ? row.lastLoginAt.toISOString() : null,
          revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
          createdAt: row.createdAt.toISOString(),
        }));
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
        const passwordHash = await this.passwords.hash(input.password);

        return this.prisma.$transaction(async (tx) => {
          const created = await tx.operator.create({
            data: {
              email: OperatorService.normalise(input.email),
              fullName: input.fullName,
              role: input.role,
              passwordHash,
            },
          });

          // Same transaction: an operator account that exists with no record of
          // who created it is precisely the row a compliance review cannot use.
          await this.audit.record(
            {
              actorType: 'OPERATOR',
              operatorId: actor.operatorId,
              operatorEmail: actor.email,
              operatorRole: actor.role,
              action: 'operator.created',
              entityType: 'Operator',
              entityId: created.id,
              reason,
              metadata: { email: created.email, role: created.role },
            },
            tx,
          );

          return { id: created.id, email: created.email };
        });
      },
    );
  }

  async signOut(token: string, session: OperatorSession): Promise<void> {
    // The operator id is passed so the hash also leaves the reverse index —
    // otherwise `revokeAll` keeps counting sessions that no longer exist.
    await this.sessions.close(token, session.operatorId);
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

        /**
         * TWO REFUSALS THAT EXIST TO KEEP THE CONSOLE REACHABLE.
         *
         * NOBODY CHANGES THEMSELVES. Not because self-demotion is dangerous in
         * itself, but because it is the one mistake that cannot be undone from
         * inside the product: an operator who suspends their own account is an
         * operator who now needs a database session to get back in. It also
         * removes the shape of every «I revoked myself to test it» incident.
         *
         * AND THE LAST SUPER_ADMIN STAYS. `operators.manage` is held by
         * SUPER_ADMIN alone, so demoting or suspending the last one leaves a
         * deployment where no route can create or restore an operator — and the
         * bootstrap has closed permanently. The only remaining path would be
         * emptying the table by hand. Checked here for a clear message and
         * checked AGAIN inside the transaction, where it is actually enforced.
         */
        if (targetId === actor.operatorId) {
          throw new ConflictException({
            code: 'OPERATOR_CANNOT_MODIFY_SELF',
            message: 'An operator cannot change their own role or status. Ask another SUPER_ADMIN.',
            messageAr: 'لا يمكن للمشغّل تغيير دوره أو حالته بنفسه. اطلب ذلك من مشغّل أعلى.',
          });
        }

        /**
         * SESSIONS DIE FIRST, AND THE ORDER IS THE WHOLE POINT.
         *
         * Redis cannot join a Postgres transaction, so one of the two steps has
         * to be able to fail after the other succeeded, and the choice is which
         * failure we would rather have:
         *
         *   update-then-revoke — the revoke fails and a REVOKED operator keeps a
         *   working console for up to eight hours. This is the failure the whole
         *   session store was built to make impossible.
         *
         *   revoke-then-update — the update fails and an operator who is still
         *   ACTIVE was signed out. They sign in again. Nothing is lost.
         *
         * The second is a nuisance; the first is the defect. So: revoke, commit,
         * then revoke ONCE MORE — because between the two the person could have
         * signed in again with credentials that were, at that instant, still
         * valid. The second sweep costs one Redis round trip and closes it.
         */
        const sessionsKilled = await this.sessions.revokeAll(targetId);

        await this.prisma.$transaction(async (tx) => {
          // THE LAST SUPER_ADMIN, enforced where it counts. If this change would
          // stop the target from being an active SUPER_ADMIN, some OTHER active
          // SUPER_ADMIN must remain — otherwise `operators.manage` has no holder
          // and the console can never gain one again.
          const losesSuperAdmin =
            previous.role === 'SUPER_ADMIN' &&
            previous.status === 'ACTIVE' &&
            ((changes.role !== undefined && changes.role !== 'SUPER_ADMIN') ||
              (changes.status !== undefined && changes.status !== 'ACTIVE'));

          if (losesSuperAdmin) {
            const remaining = await tx.operator.count({
              where: { role: 'SUPER_ADMIN', status: 'ACTIVE', id: { not: targetId } },
            });
            if (remaining === 0) {
              throw new ConflictException({
                code: 'OPERATOR_LAST_SUPER_ADMIN',
                message: 'This is the only active SUPER_ADMIN. Promote another one first.',
                messageAr: 'هذا هو المشغّل الأعلى الوحيد النشط. عيّن غيره أولًا.',
              });
            }
          }

          await tx.operator.update({
            where: { id: targetId },
            data: {
              ...(changes.role ? { role: changes.role } : {}),
              ...(changes.status ? { status: changes.status } : {}),
              // A tombstone, set once. Revocation is a fact an audit trail keeps.
              ...(changes.status === 'REVOKED' && !previous.revokedAt ? { revokedAt: new Date() } : {}),
            },
          });

          await this.audit.record(
            {
              actorType: 'OPERATOR',
              operatorId: actor.operatorId,
              operatorEmail: actor.email,
              operatorRole: actor.role,
              action: changes.status === 'REVOKED' ? 'operator.revoked' : 'operator.updated',
              entityType: 'Operator',
              entityId: targetId,
              reason,
              metadata: {
                // What it WAS, so the change is reversible by reading rather
                // than by remembering — the same rule the plan catalogue follows.
                previous: { role: previous.role, status: previous.status },
                next: { role: changes.role ?? previous.role, status: changes.status ?? previous.status },
                sessionsKilled,
              },
            },
            tx,
          );
        });

        const raced = await this.sessions.revokeAll(targetId);
        if (raced > 0) {
          this.logger.warn(
            JSON.stringify({ event: 'operator.sessions_revoked_after_commit', operatorId: targetId, count: raced }),
          );
        }

        return { id: targetId, sessionsKilled: sessionsKilled + raced };
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
