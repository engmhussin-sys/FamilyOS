import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../../../common/prisma/prisma.service';
import { runAsSystemAsync } from '../../../../common/tenancy/system-context';
import type { JobOutcome, PlatformJobDefinition } from '../../domain/job.types';

export const EXPIRED_TOKEN_SWEEP_JOB = 'expired-token-sweep';

/**
 * How long a dead refresh token is kept after it stops being usable.
 *
 * NOT ZERO, deliberately, and the reason is SA-002. `refresh_tokens` is the
 * table reuse detection reads: presenting an already-rotated token must
 * identify the whole compromised lineage through `family_token_id`. Deleting a
 * revoked token the instant it is revoked would mean an attacker who presents
 * it a minute later looks like a first-time user with an unknown token rather
 * than like a replay of a known chain — the forensic signal is destroyed by the
 * cleanup. Thirty days keeps the lineage reconstructable for a realistic
 * investigation window and no longer.
 */
export const EXPIRED_TOKEN_GRACE_DAYS = 30;

/** Bounded, for the same reason every retention delete is bounded. */
const TOKEN_SWEEP_BATCH_SIZE = 1_000;
const TOKEN_SWEEP_MAX_BATCHES = 200;

/**
 * PHASE C P4 — expired sessions and dead one-time tokens.
 *
 * WHAT WAS BROKEN BY ITS ABSENCE. Nothing user-visible, and saying otherwise
 * would be inflation: `TokenService.verify` already rejects an expired token
 * (`token.service.ts:157`) and the repository already filters on
 * `expiresAt: { gt: now }`. What accumulated was the ROW — one per login, per
 * device, per rotation, forever, on a table every refresh reads. This job
 * removes the corpse, not the risk.
 *
 * PAIRING CODES AND REGISTRATION TOKENS ARE NOT HERE, and their absence is a
 * finding rather than an omission: they live in Redis with a real TTL
 * (`RedisService.setWithTtl`, consumed atomically by `getAndDelete`), so they
 * expire without anyone sweeping them. That is the correct design and it is
 * why this job has exactly one table in it. `organization_invitations` are
 * likewise left alone — an expired B2B invitation is a record of an offer that
 * was made, on the parallel organisation tenant axis, and deleting it is a B2B
 * product decision this sprint has no mandate over.
 *
 * TENANCY: `RefreshToken` is a GLOBAL model (an auth artefact looked up by a
 * secret hash before any tenant is known), so there is no `family_id` to scope
 * by and none is invented. The bypass is still declared, because a background
 * sweep with no request behind it must always say why it is allowed to run.
 */
@Injectable()
export class ExpiredTokenSweepJob {
  private readonly logger = new Logger(ExpiredTokenSweepJob.name);

  constructor(private readonly prisma: PrismaService) {}

  definition(): PlatformJobDefinition {
    return {
      name: EXPIRED_TOKEN_SWEEP_JOB,
      scope: 'PLATFORM',
      description:
        'كنس الجلسات المنتهية: يحذف refresh tokens المنتهية أو الملغاة بعد مهلة احتفاظ جنائية قدرها ٣٠ يومًا.',
      handler: (ctx) => this.run(ctx.now),
    };
  }

  /**
   * IDEMPOTENT: the predicate is absolute (`expires_at < cutoff`), so a second
   * run finds nothing the first left. DETERMINISTIC: `now` is a parameter.
   */
  async run(now: Date): Promise<JobOutcome> {
    const cutoff = new Date(now.getTime() - EXPIRED_TOKEN_GRACE_DAYS * 24 * 60 * 60 * 1000);

    const deleted = await runAsSystemAsync(
      'SCHEDULED_JOB',
      'Scheduled sweep removes refresh tokens that expired or were revoked more than the forensic grace period ago; refresh_tokens is a GLOBAL model with no tenant column to scope by.',
      async () => {
        let total = 0;
        for (let batch = 0; batch < TOKEN_SWEEP_MAX_BATCHES; batch++) {
          // A token is sweepable when it can no longer be presented AND the
          // forensic window on it has closed. `revoked_at` is checked as well
          // as `expires_at` because SA-002 revokes a whole lineage at once,
          // often long before the individual tokens would have expired.
          const count = await this.prismaRaw().$executeRawUnsafe(
            `DELETE FROM "refresh_tokens" WHERE "id" IN (
               SELECT "id" FROM "refresh_tokens"
                WHERE ("expires_at" < $1::timestamptz)
                   OR ("revoked_at" IS NOT NULL AND "revoked_at" < $1::timestamptz)
                ORDER BY "expires_at"
                LIMIT $2::int)`,
            cutoff,
            TOKEN_SWEEP_BATCH_SIZE,
          );
          total += Number(count);
          if (Number(count) < TOKEN_SWEEP_BATCH_SIZE) break;
        }
        return total;
      },
    );

    if (deleted > 0) {
      this.logger.log(
        `session.expired_tokens_swept deleted=${deleted} graceDays=${EXPIRED_TOKEN_GRACE_DAYS}`,
      );
    }
    return { affectedRows: deleted, details: { refresh_tokens: deleted } };
  }

  /* eslint-disable @typescript-eslint/no-explicit-any */
  private prismaRaw(): {
    $executeRawUnsafe: (sql: string, ...params: unknown[]) => Promise<number>;
  } {
    return this.prisma as any;
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
}
