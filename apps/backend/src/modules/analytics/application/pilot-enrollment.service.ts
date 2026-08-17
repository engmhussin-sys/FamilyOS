import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { runInSystemScope } from './system-scope';
import { GrowthSettingsService } from './growth-settings.service';
import {
  PILOT_SETTING_KEYS,
  type PilotGateDecision,
  isCountryInPilot,
  isPilotGateAllowed,
  normalisePilotCountry,
  normalisePilotEmail,
  parsePilotCountries,
} from '../domain/pilot';

export interface IPilotGateResult {
  readonly decision: PilotGateDecision;
  readonly allowed: boolean;
  /** The cohort this registration will join. Null unless `decision` is INVITED. */
  readonly cohortId: string | null;
  /** The invitation row to redeem after the family exists. Null otherwise. */
  readonly inviteId: string | null;
  /**
   * F1. The country the OPERATOR recorded on the invitation, when this
   * registration is an invited one. Null for every other decision.
   *
   * It is carried out of the gate rather than re-queried by the caller because
   * the gate has already read that row, and a second read is a second chance
   * for the two to disagree. `AuthService.register` prefers this value over
   * anything the client sent — see the comment at that call site.
   */
  readonly inviteCountryCode: string | null;
}

/**
 * G16 — THE CONTROLLED-PILOT GATE (Saudi Arabia + Egypt).
 *
 * Two operations, in this order, and they are deliberately separate:
 *
 *   [evaluate]  BEFORE the family is created — may this registration proceed?
 *   [redeem]    AFTER the family is created  — record cohort, country, family.
 *
 * WHY SPLIT. The refusal must happen before an account exists, or a rejected
 * household still leaves a User and a Family behind. The recording must happen
 * after, because `redeemed_by_family_id` cannot be written before there is a
 * family to name. Fusing them would force one of the two to be wrong.
 *
 * THIS SERVICE LIVES IN `GrowthCaptureModule`, WHICH IMPORTS NOTHING. That is
 * load-bearing: `AuthModule` depends on it, and depending on the full
 * `AnalyticsModule` would close the cycle
 * Auth -> Analytics -> Events -> Pairing -> Auth. Its two dependencies —
 * `PrismaService` (@Global) and `GrowthSettingsService` (already provided here) —
 * add no import to that module.
 *
 * NOTHING IS LAUNCHED BY THIS CLASS EXISTING. `pilot.enabled` defaults to
 * `false`, and migration 0021 seeds no settings row, so [evaluate] returns
 * `PILOT_DISABLED` / allowed on every deployment until an admin turns it on.
 */
@Injectable()
export class PilotEnrollmentService {
  private readonly logger = new Logger(PilotEnrollmentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: GrowthSettingsService,
  ) {}

  /**
   * Decides whether a registration may proceed. Called BEFORE any row is written.
   *
   * FAILS OPEN, AND THAT IS A DELIBERATE, NARROW CHOICE. If the settings read or
   * the invite lookup throws, this returns `PILOT_DISABLED` / allowed rather than
   * refusing. The two candidate failure modes are:
   *
   *   fail closed — a database blip makes the product unbuyable for everyone,
   *                 including every household outside the pilot markets entirely;
   *   fail open   — a database blip lets an uninvited household into a pilot.
   *
   * The second is recoverable (the invite table shows no matching row, and the
   * family can be moved or removed); the first is an outage of the most important
   * request in the funnel, caused by a feature that is off by default. The
   * exception is logged at error level so it is never silent.
   */
  async evaluate(email: string, countryCode: string | null | undefined): Promise<IPilotGateResult> {
    try {
      const enabled = await this.settings.bool(PILOT_SETTING_KEYS.enabled);
      if (!enabled) return this.result('PILOT_DISABLED');

      const countries = parsePilotCountries(await this.settings.text(PILOT_SETTING_KEYS.countries));
      if (!isCountryInPilot(countryCode, countries)) {
        return this.result('COUNTRY_NOT_IN_PILOT');
      }

      const cohortId = await this.settings.text(PILOT_SETTING_KEYS.cohortId);
      const invite = await this.findInvite(normalisePilotEmail(email), cohortId);

      if (!invite) return this.result('NOT_INVITED');
      if (invite.redeemedAt !== null) return this.result('INVITE_ALREADY_REDEEMED');

      return {
        decision: 'INVITED',
        allowed: true,
        cohortId,
        inviteId: invite.id,
        inviteCountryCode: invite.countryCode,
      };
    } catch (err) {
      this.logger.error(
        `pilot.gate_evaluation_failed — failing OPEN so a configuration or database ` +
          `fault cannot stop registration. ${err instanceof Error ? err.message : String(err)}`,
      );
      return this.result('PILOT_DISABLED');
    }
  }

  /**
   * Records the enrolment: marks the invitation redeemed and binds it to the
   * family that just registered. Called AFTER the family row exists.
   *
   * CONDITIONAL ON `redeemedAt: null` IN THE WHERE CLAUSE, not merely checked in
   * [evaluate] beforehand. Two registrations racing on one invitation would both
   * pass evaluate; only one can pass this update. `updateMany` returning a count
   * makes losing that race observable rather than silent — and the loser keeps its
   * account, because refusing at this point would delete a household over a race
   * on a marketing record.
   *
   * Never throws: by the time this runs the family exists and the account is
   * valid. A failure to write a cohort label is a reporting problem, and it must
   * not turn a completed registration into a 500 — the same posture
   * `AttributionService.captureAtRegistration` already takes.
   */
  async redeem(inviteId: string, familyId: string): Promise<boolean> {
    try {
      const updated = await runInSystemScope(
        'ADMIN_CONSOLE',
        'pilot_invites is a GLOBAL allow-list with no family_id column; the row being redeemed is named by id.',
        () =>
          this.prisma.pilotInvite.updateMany({
            where: { id: inviteId, redeemedAt: null },
            data: { redeemedAt: new Date(), redeemedByFamilyId: familyId },
          }),
      );

      if (updated.count === 0) {
        // Lost a race, or the row was withdrawn between evaluate and here.
        this.logger.warn(
          `pilot.invite_not_redeemed inviteId=${inviteId.slice(0, 8)} family=${familyId.slice(0, 8)} ` +
            `— it was already redeemed or withdrawn. The account is kept; the cohort label is not recorded.`,
        );
        return false;
      }

      this.logger.log(
        `pilot.enrolled family=${familyId.slice(0, 8)} invite=${inviteId.slice(0, 8)}`,
      );
      return true;
    } catch (err) {
      this.logger.error(
        `pilot.redeem_failed inviteId=${inviteId.slice(0, 8)} — the registration stands. ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Creates an invitation. The operator-facing half; there is deliberately no
   * public HTTP route for it in this change, because G16 is configuration and not
   * a launch. Seeding is done by an admin/console path or a migration when a wave
   * actually starts.
   */
  async invite(input: {
    email: string;
    cohortId: string;
    countryCode: string;
    invitedByUserId?: string | null;
  }): Promise<{ id: string }> {
    const email = normalisePilotEmail(input.email);
    const countryCode = normalisePilotCountry(input.countryCode);

    return runInSystemScope(
      'ADMIN_CONSOLE',
      'pilot_invites is a GLOBAL allow-list with no family_id column; an operator is adding an invited household.',
      () =>
        this.prisma.pilotInvite.upsert({
          where: { email_cohortId: { email, cohortId: input.cohortId } },
          // Re-inviting an address already in this cohort must NOT reset a
          // redemption: that would hand a used invitation back out.
          update: { countryCode },
          create: {
            email,
            cohortId: input.cohortId,
            countryCode,
            invitedByUserId: input.invitedByUserId ?? null,
          },
          select: { id: true },
        }),
    );
  }

  /** The cohort and country actually recorded for a family, or null. */
  async enrolmentOf(
    familyId: string,
  ): Promise<{ cohortId: string; countryCode: string; redeemedAt: Date } | null> {
    const row = await runInSystemScope(
      'ADMIN_CONSOLE',
      'pilot_invites is a GLOBAL allow-list with no family_id column; this reads the row that names the family.',
      () =>
        this.prisma.pilotInvite.findFirst({
          where: { redeemedByFamilyId: familyId },
          select: { cohortId: true, countryCode: true, redeemedAt: true },
        }),
    );
    if (!row || row.redeemedAt === null) return null;
    return { cohortId: row.cohortId, countryCode: row.countryCode, redeemedAt: row.redeemedAt };
  }

  private findInvite(
    email: string,
    cohortId: string,
  ): Promise<{ id: string; redeemedAt: Date | null; countryCode: string } | null> {
    return runInSystemScope(
      'ADMIN_CONSOLE',
      'pilot_invites is a GLOBAL allow-list with no family_id column; the gate runs before a family exists.',
      () =>
        this.prisma.pilotInvite.findUnique({
          where: { email_cohortId: { email, cohortId } },
          // F1: `countryCode` joins the projection. It is the operator's record
          // of where the invited household is, written by `invite()` above, and
          // it is what `Family.countryCode` is set from for a pilot household.
          select: { id: true, redeemedAt: true, countryCode: true },
        }),
    );
  }

  private result(decision: PilotGateDecision): IPilotGateResult {
    return {
      decision,
      allowed: isPilotGateAllowed(decision),
      cohortId: null,
      inviteId: null,
      inviteCountryCode: null,
    };
  }
}
