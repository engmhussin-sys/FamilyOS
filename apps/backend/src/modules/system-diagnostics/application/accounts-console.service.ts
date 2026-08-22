import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../common/prisma/prisma.service';

/**
 * ===========================================================================
 * THE ACCOUNTS CONSOLE — households, one row each, for the platform owner.
 * ===========================================================================
 *
 * WHAT WAS MISSING. Every platform-wide surface in this product answers with an
 * AGGREGATE: `GET /analytics/dashboard-metrics` returns `totalFamilies` and
 * `activeFamiliesLast7Days`, `/admin/growth/families` returns a count per
 * market. Not one of them can answer the first question an owner actually asks
 * — «who is on my platform, and what state are they in?» — because none of them
 * returns rows. This does.
 *
 * ======================= WHY THIS IS RAW SQL AND NOT PRISMA ================
 *
 * The Prisma client this application uses is wrapped by the tenant extension:
 * every model query is rewritten to a single `family_id`, which is exactly
 * right for the request path and exactly wrong here — an operator console has
 * no tenant and must see every household. `@SystemRoute('ADMIN_CONSOLE')` puts
 * the request in a system context so the extension passes through, and the
 * counts below are computed in ONE statement rather than N+1 per-family
 * queries: a console that issues five queries per row is a console that stops
 * working at the exact moment the platform starts succeeding.
 *
 * NOTHING HERE READS A PERSONAL DETAIL BEYOND THE OWNER'S EMAIL. No child name,
 * no date of birth, no location, no message content. The owner's email is the
 * one field an operator genuinely acts on — it is what the grant console and
 * every support conversation are keyed by — and it is the same field the
 * platform's own login uses. Everything else is a count, a status or a date.
 *
 * ============================ KEYSET, NOT OFFSET ==========================
 *
 * `OFFSET n` makes the database walk and discard n rows, so page 400 costs
 * four hundred times page one, and a row inserted mid-scroll shifts every
 * subsequent page. The cursor is `(created_at, id)` — the same keyset shape
 * the family sweeps in this repository already use — so each page costs the
 * same and no household is silently skipped or repeated.
 */

export interface IAccountRow {
  familyId: string;
  familyName: string;
  countryCode: string | null;
  createdAt: string;
  ownerEmail: string | null;
  /** ACTIVE / SUSPENDED / PENDING_VERIFICATION, from the owner's user row. */
  ownerStatus: string | null;
  memberCount: number;
  childCount: number;
  deviceCount: number;
  /** Null when the household has never had a subscription row at all. */
  subscriptionStatus: string | null;
  planTier: string | null;
  /** The newest device heartbeat on the household, or null if none ever. */
  lastSeenAt: string | null;
  /** True while at least one entitlement row is live right now. */
  hasLiveEntitlement: boolean;
}

interface IRawRow {
  family_id: string;
  family_name: string;
  country_code: string | null;
  created_at: Date;
  owner_email: string | null;
  owner_status: string | null;
  member_count: bigint | number;
  child_count: bigint | number;
  device_count: bigint | number;
  subscription_status: string | null;
  plan_tier: string | null;
  last_seen_at: Date | null;
  live_entitlements: bigint | number;
}

@Injectable()
export class AccountsConsoleService {
  /** A page nobody asked to be larger, and a ceiling nobody can raise by query. */
  static readonly DEFAULT_LIMIT = 25;
  static readonly MAX_LIMIT = 100;

  constructor(private readonly prisma: PrismaService) {}

  async list(input: {
    limit?: number;
    cursor?: string | null;
    search?: string | null;
  }): Promise<{ rows: IAccountRow[]; nextCursor: string | null }> {
    const limit = Math.min(
      Math.max(input.limit ?? AccountsConsoleService.DEFAULT_LIMIT, 1),
      AccountsConsoleService.MAX_LIMIT,
    );

    /**
     * The cursor is opaque to the client and is `${createdAtIso}|${id}`. It is
     * parsed defensively: a malformed cursor starts from the beginning rather
     * than throwing, because a console that 500s on a stale bookmark is a
     * console people stop trusting.
     */
    let cursorCreatedAt: Date | null = null;
    let cursorId: string | null = null;
    if (input.cursor) {
      const [iso, id] = input.cursor.split('|');
      const parsed = new Date(iso);
      if (!Number.isNaN(parsed.getTime()) && id) {
        cursorCreatedAt = parsed;
        cursorId = id;
      }
    }

    const search = input.search?.trim().toLowerCase() || null;

    /**
     * `$queryRaw` with interpolated PARAMETERS, never interpolated strings —
     * every value below crosses as a bind parameter, so a search term is data
     * and can never become SQL.
     */
    const rows = await this.prisma.$queryRaw<IRawRow[]>`
      WITH owner AS (
        SELECT DISTINCT ON (fm.family_id)
               fm.family_id, u.email, u.status::text AS status
          FROM family_members fm
          JOIN users u ON u.id = fm.user_id
         WHERE fm.deleted_at IS NULL
         ORDER BY fm.family_id, (fm.role = 'OWNER') DESC, fm.joined_at ASC
      )
      SELECT f.id                                   AS family_id,
             f.name                                 AS family_name,
             f.country_code                         AS country_code,
             f.created_at                           AS created_at,
             owner.email                            AS owner_email,
             owner.status                           AS owner_status,
             (SELECT count(*) FROM family_members m
               WHERE m.family_id = f.id AND m.deleted_at IS NULL)      AS member_count,
             (SELECT count(*) FROM children c
               WHERE c.family_id = f.id AND c.deleted_at IS NULL)      AS child_count,
             (SELECT count(*) FROM devices d
               WHERE d.family_id = f.id)                               AS device_count,
             s.status::text                         AS subscription_status,
             s.plan_tier::text                      AS plan_tier,
             (SELECT max(d.last_seen_at) FROM devices d
               WHERE d.family_id = f.id)                               AS last_seen_at,
             (SELECT count(*) FROM entitlements e
               WHERE e.family_id = f.id
                 AND e.status = 'ACTIVE'
                 AND e.valid_from <= now()
                 AND (e.valid_until IS NULL OR e.valid_until > now()))  AS live_entitlements
        FROM families f
        LEFT JOIN owner        ON owner.family_id = f.id
        LEFT JOIN subscriptions s ON s.family_id = f.id
       WHERE f.deleted_at IS NULL
         AND (${search}::text IS NULL
              OR lower(f.name) LIKE '%' || ${search}::text || '%'
              OR lower(coalesce(owner.email, '')) LIKE '%' || ${search}::text || '%')
         AND (${cursorCreatedAt}::timestamptz IS NULL
              OR (f.created_at, f.id) < (${cursorCreatedAt}::timestamptz, ${cursorId}::uuid))
       ORDER BY f.created_at DESC, f.id DESC
       LIMIT ${limit + 1}
    `;

    // One row more than the page was fetched, so "is there a next page" is
    // answered by evidence rather than by comparing a count to the limit and
    // guessing when they happen to be equal.
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];

    return {
      rows: page.map((row) => ({
        familyId: row.family_id,
        familyName: row.family_name,
        countryCode: row.country_code,
        createdAt: row.created_at.toISOString(),
        ownerEmail: row.owner_email,
        ownerStatus: row.owner_status,
        memberCount: Number(row.member_count),
        childCount: Number(row.child_count),
        deviceCount: Number(row.device_count),
        subscriptionStatus: row.subscription_status,
        planTier: row.plan_tier,
        lastSeenAt: row.last_seen_at ? row.last_seen_at.toISOString() : null,
        hasLiveEntitlement: Number(row.live_entitlements) > 0,
      })),
      nextCursor: hasMore && last ? `${last.created_at.toISOString()}|${last.family_id}` : null,
    };
  }
}
