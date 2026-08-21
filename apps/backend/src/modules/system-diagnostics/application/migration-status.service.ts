import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../common/prisma/prisma.service';

/**
 * WHAT THE DEPLOYED DATABASE SAYS ABOUT ITSELF — never what this build hopes.
 *
 * ========================== THE GAP THIS CLOSES ==========================
 *
 * `railway.json` runs `npx prisma migrate deploy` as a `preDeployCommand`, and
 * a green "Deployed" badge was, until this file existed, the ONLY evidence that
 * it did anything. That badge is not evidence: `preDeployCommand` can be
 * silently unset on the service, the migration step can be skipped when the
 * config-as-code path is wrong, and a container can boot perfectly against a
 * schema that is several migrations behind the code now running on top of it.
 * The failure mode is not a crash — it is a 200 on every route that happens not
 * to touch the newest column, until one does.
 *
 * `GET /health/ready` cannot answer this. It asks "is Postgres reachable",
 * which a schema from three weeks ago answers just as cheerfully as today's.
 *
 * So this reports what is IN `_prisma_migrations`, the table Prisma Migrate
 * itself maintains: how many migrations finished, which one was last, and
 * whether any is in the two states that mean a deploy is broken rather than
 * behind — started and never finished, or rolled back.
 *
 * ====================== IT DELIBERATELY OWNS NO EXPECTATION ==================
 *
 * It does NOT compare against a count baked into this build. A number compiled
 * into the image is a claim about the image, and two images disagreeing about
 * how many migrations "should" exist is a second source of truth for the thing
 * this file was written to have exactly one of. The expectation belongs to the
 * caller holding the repository — `scripts/deploy-doctor.*` compares
 * `latestName` here against the newest directory under `prisma/migrations/`,
 * where that fact actually lives.
 *
 * ============================= AND IT NEVER 500s =============================
 *
 * A database with no `_prisma_migrations` table at all (schema pushed with
 * `db push`, or a genuinely empty database) is a REPORTABLE STATE, not an
 * exception. Throwing here would take the whole diagnostics response down and
 * hide the eight other fields an operator called it for — while proving nothing
 * except that something went wrong somewhere. `available: false` with the
 * reason is strictly more information than a 500.
 */
export interface IMigrationStatus {
  /** false only when `_prisma_migrations` could not be read at all. */
  available: boolean;
  /** Present only when `available` is false: why the table could not be read. */
  reason?: string;
  /** Migrations with a `finished_at` and no `rolled_back_at`. */
  appliedCount: number;
  /** The newest applied migration's directory name, e.g. `0030_retire_…`. */
  latestName: string | null;
  /** ISO-8601, or null when nothing has been applied. */
  latestAppliedAt: string | null;
  /**
   * Migrations that are recorded but NOT cleanly applied — started with no
   * `finished_at`, or rolled back. Any value above zero means the deploy is
   * broken, not merely behind, and `latestName` must not be read as "the
   * schema is at this version".
   */
  unfinishedCount: number;
  /** Names of the unfinished/rolled-back rows, so the operator need not guess. */
  unfinishedNames: string[];
}

interface IMigrationRow {
  migration_name: string;
  finished_at: Date | null;
  rolled_back_at: Date | null;
}

@Injectable()
export class MigrationStatusService {
  constructor(private readonly prisma: PrismaService) {}

  async read(): Promise<IMigrationStatus> {
    let rows: IMigrationRow[];
    try {
      /**
       * Ordered by `finished_at` and not by `started_at`: `migrate deploy`
       * applies in lexical order, but a resumed or repaired deploy can start a
       * later migration before an earlier one finishes, and "the newest thing
       * that is actually in the schema" is what an operator is asking for.
       * NULLS LAST keeps an unfinished row from being read as the latest.
       */
      rows = await this.prisma.$queryRaw<IMigrationRow[]>`
        SELECT migration_name, finished_at, rolled_back_at
        FROM "_prisma_migrations"
        ORDER BY finished_at ASC NULLS LAST
      `;
    } catch (err) {
      return {
        available: false,
        reason: err instanceof Error ? err.message : 'Could not read _prisma_migrations.',
        appliedCount: 0,
        latestName: null,
        latestAppliedAt: null,
        unfinishedCount: 0,
        unfinishedNames: [],
      };
    }

    const applied = rows.filter((r) => r.finished_at !== null && r.rolled_back_at === null);
    const unfinished = rows.filter((r) => r.finished_at === null || r.rolled_back_at !== null);
    const latest = applied.length > 0 ? applied[applied.length - 1] : null;

    return {
      available: true,
      appliedCount: applied.length,
      latestName: latest ? latest.migration_name : null,
      latestAppliedAt: latest?.finished_at ? new Date(latest.finished_at).toISOString() : null,
      unfinishedCount: unfinished.length,
      unfinishedNames: unfinished.map((r) => r.migration_name),
    };
  }
}
