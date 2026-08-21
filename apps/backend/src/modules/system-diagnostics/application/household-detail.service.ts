import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../../../common/prisma/prisma.service';

/**
 * ===========================================================================
 * ONE HOUSEHOLD, IN ENOUGH DETAIL TO INVESTIGATE A COMPLAINT.
 * ===========================================================================
 *
 * WHAT THE LIST COULD NOT DO. `GET /system/accounts` answers «who is on this
 * platform» with counts — two children, three devices, one live grant. An owner
 * reading a complaint needs the next question answered: WHICH children, WHICH
 * devices, when did each last report, and what has anyone done to this account.
 * Counts cannot answer any of that, and the alternative is a SQL console.
 *
 * ======================= WHAT IT SHOWS, AND WHAT IT WILL NOT ===============
 *
 * It shows the operational shape of a household: members and their status,
 * children by FIRST NAME AND AGE BAND ONLY, devices with their platform and
 * last heartbeat, the subscription, the live entitlements, and the audit trail.
 *
 * IT DOES NOT SHOW A CHILD'S DATE OF BIRTH, and that is a deliberate line
 * rather than an oversight. An operator investigating «the app stopped
 * reporting on my son's phone» needs to know WHICH child, not when he was born;
 * `ageYears` answers the first and not the second. It shows no message content,
 * no location, no screen-time detail and no notification body — every one of
 * those is a family's private life, and an operator console is exactly the
 * place where "we could show it" must not become "we show it".
 *
 * The audit trail is the half that makes this a console rather than a report:
 * it is where an operator's own actions appear, including the plan grants this
 * platform's staff make. A console that can act and cannot show what it did is
 * a console nobody can be held to.
 */

export interface IHouseholdDetail {
  familyId: string;
  familyName: string;
  countryCode: string | null;
  timezone: string;
  createdAt: string;
  members: {
    userId: string;
    email: string;
    fullName: string;
    role: string;
    status: string;
    emailVerifiedAt: string | null;
    joinedAt: string;
  }[];
  children: { childId: string; firstName: string; ageYears: number | null; createdAt: string }[];
  devices: { deviceId: string; platform: string | null; status: string | null; lastSeenAt: string | null }[];
  subscription: { planTier: string; status: string; trialEndsAt: string | null; currentPeriodEnd: string | null } | null;
  entitlements: { featureKey: string; status: string; source: string; validUntil: string | null }[];
  audit: { action: string; actorType: string; createdAt: string; metadata: unknown }[];
}

@Injectable()
export class HouseholdDetailService {
  /** The audit trail is a tail, not a history: the console shows the recent past. */
  static readonly AUDIT_LIMIT = 50;

  constructor(private readonly prisma: PrismaService) {}

  async get(familyId: string): Promise<IHouseholdDetail> {
    /**
     * Raw SQL for the same reason the accounts list uses it: the tenant
     * extension rewrites every model query to ONE family, which is right for a
     * request and wrong for an operator console reading a family it does not
     * belong to. `@SystemRoute('ADMIN_CONSOLE')` puts the request in a system
     * context; the parameter below is the only thing that scopes these reads,
     * and it comes from the URL and is a bound parameter, never a string.
     */
    const families = await this.prisma.$queryRaw<
      { id: string; name: string; country_code: string | null; timezone: string; created_at: Date }[]
    >`SELECT id, name, country_code, timezone, created_at
        FROM families WHERE id = ${familyId}::uuid AND deleted_at IS NULL`;

    if (families.length === 0) {
      throw new NotFoundException({ code: 'FAMILY_NOT_FOUND', message: 'No such household.' });
    }
    const family = families[0];

    const [members, children, devices, subscriptions, entitlements, audit] = await Promise.all([
      this.prisma.$queryRaw<any[]>`
        SELECT u.id AS user_id, u.email, u.full_name, u.status::text AS status,
               u.email_verified_at, fm.role::text AS role, fm.joined_at
          FROM family_members fm JOIN users u ON u.id = fm.user_id
         WHERE fm.family_id = ${familyId}::uuid AND fm.deleted_at IS NULL
         ORDER BY (fm.role = 'OWNER') DESC, fm.joined_at ASC`,

      /**
       * AGE IN YEARS, COMPUTED IN SQL, AND NEVER THE DATE ITSELF. The column is
       * not selected at all, so it cannot reach the response through a later
       * careless spread — the safest way to not disclose a field is not to read
       * it.
       */
      this.prisma.$queryRaw<any[]>`
        SELECT id AS child_id, first_name,
               date_part('year', age(date_of_birth))::int AS age_years,
               created_at
          FROM children
         WHERE family_id = ${familyId}::uuid AND deleted_at IS NULL
         ORDER BY created_at ASC`,

      this.prisma.$queryRaw<any[]>`
        SELECT id AS device_id, platform::text AS platform, status::text AS status, last_seen_at
          FROM devices WHERE family_id = ${familyId}::uuid
         ORDER BY last_seen_at DESC NULLS LAST`,

      this.prisma.$queryRaw<any[]>`
        SELECT plan_tier::text AS plan_tier, status::text AS status, trial_ends_at, current_period_end
          FROM subscriptions WHERE family_id = ${familyId}::uuid`,

      this.prisma.$queryRaw<any[]>`
        SELECT feature_key, status::text AS status, source::text AS source, valid_until
          FROM entitlements WHERE family_id = ${familyId}::uuid
         ORDER BY valid_until DESC NULLS FIRST`,

      this.prisma.$queryRaw<any[]>`
        SELECT action, actor_type::text AS actor_type, created_at, metadata
          FROM audit_logs WHERE family_id = ${familyId}::uuid
         ORDER BY created_at DESC
         LIMIT ${HouseholdDetailService.AUDIT_LIMIT}`,
    ]);

    const iso = (value: Date | null | undefined): string | null => (value ? new Date(value).toISOString() : null);

    return {
      familyId: family.id,
      familyName: family.name,
      countryCode: family.country_code,
      timezone: family.timezone,
      createdAt: family.created_at.toISOString(),
      members: members.map((row) => ({
        userId: row.user_id,
        email: row.email,
        fullName: row.full_name,
        role: row.role,
        status: row.status,
        emailVerifiedAt: iso(row.email_verified_at),
        joinedAt: new Date(row.joined_at).toISOString(),
      })),
      children: children.map((row) => ({
        childId: row.child_id,
        firstName: row.first_name,
        ageYears: row.age_years ?? null,
        createdAt: new Date(row.created_at).toISOString(),
      })),
      devices: devices.map((row) => ({
        deviceId: row.device_id,
        platform: row.platform ?? null,
        status: row.status ?? null,
        lastSeenAt: iso(row.last_seen_at),
      })),
      subscription: subscriptions[0]
        ? {
            planTier: subscriptions[0].plan_tier,
            status: subscriptions[0].status,
            trialEndsAt: iso(subscriptions[0].trial_ends_at),
            currentPeriodEnd: iso(subscriptions[0].current_period_end),
          }
        : null,
      entitlements: entitlements.map((row) => ({
        featureKey: row.feature_key,
        status: row.status,
        source: row.source,
        validUntil: iso(row.valid_until),
      })),
      audit: audit.map((row) => ({
        action: row.action,
        actorType: row.actor_type,
        createdAt: new Date(row.created_at).toISOString(),
        metadata: row.metadata,
      })),
    };
  }
}
