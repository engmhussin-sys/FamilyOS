import { Inject, Injectable, Logger } from '@nestjs/common';

import type {
  IAuthenticatedUser,
  IDeviceSessionContext,
  IRegisterParentInput,
  ITokenPair,
} from '../../domain/auth.types';
import {
  AccountNotActiveException,
  EmailAlreadyRegisteredException,
  InvalidCredentialsException,
  PilotInviteRequiredException,
} from '../../domain/auth.errors';
import {
  USER_REPOSITORY,
  type IUserRepository,
} from '../ports/auth.repository.ports';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';
import { AuditService } from '../../../audit/application/audit.service';
import { AttributionService } from '../../../analytics/application/attribution.service';
import { ReferralService } from '../../../analytics/application/referral.service';
import { PilotEnrollmentService } from '../../../analytics/application/pilot-enrollment.service';
import { CountryCatalogueService } from '../../../settings/application/country-catalogue.service';

/**
 * The domain layer intentionally does not import Prisma's generated
 * `FamilyRole` enum type directly (application/domain code should not
 * depend on the ORM's generated types — see docs/architecture/auth-module.md
 * §"Why a role-mapping helper"). Prisma guarantees the persisted value is
 * always one of these two strings, so this narrows safely rather than
 * silently trusting an arbitrary string.
 */
function toFamilyRole(role: string): IAuthenticatedUser['familyRole'] {
  if (role === 'OWNER' || role === 'PARENT') return role;
  throw new Error(`Unexpected family role value from persistence: "${role}"`);
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @Inject(USER_REPOSITORY) private readonly userRepository: IUserRepository,
    private readonly passwordService: PasswordService,
    private readonly tokenService: TokenService,
    private readonly auditService: AuditService,
    /**
     * PHASE D (GROWTH). Both come from `GrowthCaptureModule`, which imports
     * NOTHING — see its docstring. Depending on the full `AnalyticsModule`
     * here would close the cycle
     * Auth -> Analytics -> Events -> Pairing -> Auth.
     */
    private readonly attribution: AttributionService,
    private readonly referrals: ReferralService,
    /** G16. Same module, same no-import reasoning as the two above. */
    private readonly pilot: PilotEnrollmentService,
    /**
     * F1. From `SettingsModule`, which imports only `GrowthCaptureModule` — so
     * this edge cannot close a cycle either (see `settings.module.ts`). ONE
     * implementation of "is this a market we serve" serves both registration
     * and `PATCH /settings`; two would eventually disagree.
     */
    private readonly countries: CountryCatalogueService,
  ) {}

  /**
   * Registers a new parent account. Also creates that parent's Family and
   * makes them its OWNER, atomically (see PrismaUserRepository) — a
   * standalone "User" with no Family is not a valid state in this system,
   * so we never let one exist even transiently.
   */
  async register(input: IRegisterParentInput): Promise<IAuthenticatedUser> {
    const existing = await this.userRepository.findByEmail(input.email.toLowerCase());
    if (existing) {
      throw new EmailAlreadyRegisteredException(input.email);
    }

    /**
     * G16 — THE CONTROLLED-PILOT GATE, AND IT IS HERE FOR ONE REASON: this is
     * before anything is written.
     *
     * A refusal must leave NO User and NO Family behind, so the check cannot live
     * after `createParentWithFamily` (which creates both atomically) and cannot be
     * a cleanup afterwards. It also runs after the duplicate-email check above, so
     * an existing account still gets its own, more accurate 409.
     *
     * INERT BY DEFAULT. `pilot.enabled` defaults to false and migration 0021 seeds
     * no settings row, so `evaluate` returns PILOT_DISABLED / allowed and this
     * block changes nothing for any existing deployment or any family outside a
     * pilot country. See PilotEnrollmentService for why it also fails OPEN.
     */
    /**
     * F1 — THE CLIENT'S CLAIMED MARKET, CHECKED BEFORE ANYTHING IS WRITTEN.
     *
     * FIRST, so an unsupported country is a typed 400 that leaves NO User and NO
     * Family behind — the same reason the pilot gate below runs where it does.
     * Doing it after `createParentWithFamily` would mean either a household
     * created in a market we do not serve, or a foreign-key violation from
     * migration 0022 rolling back a completed registration as a 500.
     *
     * A registration that names no market skips this entirely and creates a
     * family with a NULL country, exactly as every registration did before F1.
     */
    const claimedCountry =
      input.countryCode !== undefined
        ? await this.countries.resolveSupported(input.countryCode)
        : null;

    /**
     * G16 — THE CONTROLLED-PILOT GATE, AND IT IS HERE FOR ONE REASON: this is
     * before anything is written.
     *
     * F1 changes ONE thing about the call: the country it is asked about is now
     * the registration's own `countryCode` when there is one, falling back to
     * the attribution label as before. The gate is about where the HOUSEHOLD is,
     * and a field backed by a foreign key is a better answer to that than an
     * untrusted marketing label — while a client that sends only attribution
     * still behaves exactly as it did.
     */
    const pilotGate = await this.pilot.evaluate(
      input.email,
      claimedCountry ?? input.attribution?.countryCode,
    );
    if (!pilotGate.allowed) {
      this.logger.warn(
        `auth.register_refused_by_pilot decision=${pilotGate.decision} — no account was created.`,
      );
      throw new PilotInviteRequiredException();
    }

    /**
     * F1 — PRECEDENCE: AN OPERATOR-SET COUNTRY OUTRANKS A CLIENT CLAIM.
     *
     * `pilot_invites.country_code` (migration 0021) is written by
     * `PilotEnrollmentService.invite`, i.e. by a human running the pilot who
     * decided which market this household belongs to before it existed. The
     * client's `countryCode` arrives from an app that infers it from a SIM, a
     * locale or a store front and can simply be wrong. When the two disagree the
     * operator's record wins — CONTEXT: the server is authoritative, and a value
     * a human committed to is more authoritative still.
     *
     * The invite's value is resolved through the catalogue too, but with
     * `resolveSupportedOrNull`: if a market has been CLOSED since the invitation
     * was written, this must degrade to "no country recorded" and a log line,
     * not throw. An invited household refused at registration because of a
     * settings change made after the invitation was sent would be a defect
     * caused entirely on our side.
     */
    const inviteCountry = await this.countries.resolveSupportedOrNull(
      pilotGate.inviteCountryCode,
    );
    const countryCode = inviteCountry ?? claimedCountry;
    if (inviteCountry !== null && claimedCountry !== null && inviteCountry !== claimedCountry) {
      this.logger.warn(
        `auth.register_country_from_invite invite=${inviteCountry} claimed=${claimedCountry} — ` +
          `the operator's invitation record wins.`,
      );
    }

    /**
     * F1 — THE COUNTRY AND THE CALENDAR MAY NOT DISAGREE. The rule, and the
     * reasoning behind it, live on `CountryCatalogueService.reconcileTimeZone`;
     * this is the second of its two call sites.
     *
     * `enforce` IS TRUE ONLY WHEN THE COUNTRY CAME FROM THIS CLIENT. A client
     * that sends `{countryCode: 'SA', timezone: 'Africa/Cairo'}` contradicted
     * itself and gets a 400 it can act on. But when the country came from the
     * INVITE, the mismatch is between an operator's record and a client's guess
     * — refusing there would deny an invited household its account over a
     * disagreement it cannot see or fix, so the operator's country wins, the
     * calendar is derived from it, and the override is logged.
     */
    const timezone = await this.countries.reconcileTimeZone({
      countryCode,
      timezone: input.timezone,
      enforce: inviteCountry === null,
    });

    const passwordHash = await this.passwordService.hash(input.password);
    const { user, family, membership } = await this.userRepository.createParentWithFamily(
      {
        ...input,
        email: input.email.toLowerCase(),
        // Both server-decided. `undefined` — not null — so the repository omits
        // the column and the row keeps its schema default.
        countryCode: countryCode ?? undefined,
        timezone,
      },
      passwordHash,
    );

    this.logger.log(`New parent registered: userId=${user.id} familyId=${family.id}`);

    await this.auditService.record({
      // PC-S-006. `/auth/*` runs under `@SystemRoute('AUTH_BOOTSTRAP')`, so the
      // tenant extension stamps nothing; the family is named explicitly, from
      // the row this transaction just created.
      familyId: family.id,
      actorType: 'USER',
      actorUserId: user.id,
      action: 'auth.register',
      entityType: 'User',
      entityId: user.id,
      metadata: { familyId: family.id },
    });

    /**
     * PHASE D (GROWTH) — ATTRIBUTION AND REFERRAL, CAPTURED HERE AND NOWHERE
     * ELSE.
     *
     * AFTER the family row exists and AFTER the audit record, deliberately:
     * neither of these may be able to fail a registration. `captureAtRegistration`
     * swallows its own failures (a marketing label is not worth a 500 on the
     * most important request in the funnel) and `registerReferral` returns a
     * reason instead of throwing for every rejection it knows about — a
     * mistyped or already-used referral code creates the household anyway,
     * simply uncredited.
     *
     * The `familyId` passed to both is `family.id`, the row this transaction
     * just created. It is never read from `input`.
     */
    await this.attribution.captureAtRegistration(family.id, user.id, input.attribution);

    /**
     * G16 — records the enrolment: cohort id, country and this family, on the
     * invitation row that admitted them.
     *
     * HERE, beside attribution, and for the same reason: the family row now exists
     * (so `redeemed_by_family_id` can name it) and neither of these may be able to
     * fail a registration. `redeem` never throws and returns false rather than
     * raising when it loses a race for the invitation — the household keeps the
     * account it just legitimately created, and the unrecorded label is a
     * reporting problem, not a reason to delete a family.
     *
     * `inviteId` is non-null only when the decision was INVITED, so this is a
     * no-op on every non-pilot registration.
     */
    if (pilotGate.inviteId !== null) {
      await this.pilot.redeem(pilotGate.inviteId, family.id);
    }

    const referralCode = input.attribution?.referralCode;
    if (referralCode) {
      const outcome = await this.referrals.registerReferral(family.id, referralCode);
      if (!outcome.bound) {
        this.logger.log(
          `referral.not_bound family=${family.id.slice(0, 8)} reason=${outcome.reason ?? 'UNKNOWN'} — registration unaffected.`,
        );
      }
    }

    return {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      familyId: family.id,
      familyRole: toFamilyRole(membership.role),
    };
  }

  async login(
    email: string,
    password: string,
    context: IDeviceSessionContext,
  ): Promise<{ user: IAuthenticatedUser; tokens: ITokenPair }> {
    const user = await this.userRepository.findByEmail(email.toLowerCase());
    if (!user) {
      // Deliberately identical error/timing profile to "wrong password" —
      // never reveal whether an email is registered.
      throw new InvalidCredentialsException();
    }

    const passwordValid = await this.passwordService.verify(user.passwordHash, password);
    if (!passwordValid) {
      throw new InvalidCredentialsException();
    }

    if (user.status !== 'ACTIVE' && user.status !== 'PENDING_VERIFICATION') {
      throw new AccountNotActiveException();
    }

    const membership = await this.userRepository.findPrimaryFamilyMembership(user.id);
    if (!membership) {
      // Should be unreachable given registration always creates a family —
      // if it happens, it indicates data corruption, worth its own alert.
      this.logger.error(`User ${user.id} has no family membership.`);
      throw new AccountNotActiveException();
    }

    const tokens = await this.tokenService.issueTokenPair({
      subjectId: user.id,
      actorType: 'USER',
      familyId: membership.familyId,
      // PHASE C (A4 §SA-005). The role travels in the signed token so the
      // guard chain can decide without a database round-trip on every request.
      familyRole: toFamilyRole(membership.role),
      userAgent: context.userAgent,
      ipAddress: context.ipAddress,
    });

    await this.userRepository.updateLastLoginAt(user.id, new Date());

    await this.auditService.record({
      // PC-S-006. "Who signed into this family's account, and when" is the
      // single most useful line in a custody dispute, and it was not
      // tenant-scoped. The id comes from the membership resolved above.
      familyId: membership.familyId,
      actorType: 'USER',
      actorUserId: user.id,
      action: 'auth.login',
      entityType: 'User',
      entityId: user.id,
      ipAddress: context.ipAddress,
    });

    return {
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        familyId: membership.familyId,
        familyRole: toFamilyRole(membership.role),
      },
      tokens,
    };
  }

  async refresh(
    refreshToken: string,
    context: IDeviceSessionContext,
  ): Promise<ITokenPair> {
    const { payload, record } = await this.tokenService.verifyAndConsumeRefreshToken(refreshToken);

    // Rotation: the old token is already revoked (inside verifyAndConsume,
    // which also detects and punishes reuse of an already-rotated token —
    // SA-002). The successor stays in the SAME rotation family as the
    // token it replaces, so a later reuse anywhere in this chain can
    // still revoke the whole chain in one query.
    // PHASE C. The role is RE-READ from persistence on every rotation rather
    // than copied out of the old payload. Copying it would make the claim
    // immortal: a parent demoted from OWNER would keep OWNER for as long as
    // they kept refreshing, for up to the refresh token's 30 days. Re-reading
    // bounds the staleness of any role change to one 15-minute access-token
    // lifetime. (Device tokens have no persisted role — `CHILD` is derived
    // from `actorType` — so nothing is looked up for them.)
    const familyRole =
      payload.actorType === 'USER'
        ? await this.currentFamilyRole(payload.sub)
        : undefined;

    return this.tokenService.issueTokenPair({
      subjectId: payload.sub,
      actorType: payload.actorType,
      familyId: payload.familyId,
      familyRole,
      userAgent: context.userAgent,
      ipAddress: context.ipAddress,
      familyTokenId: record.familyTokenId,
      replacesTokenId: record.id,
    });
  }

  async logout(refreshToken: string): Promise<void> {
    // Reuses the same verify-and-revoke path as refresh; we simply don't
    // issue a replacement pair afterward.
    const { payload } = await this.tokenService.verifyAndConsumeRefreshToken(refreshToken);

    await this.auditService.record({
      // PC-S-006. From the VERIFIED refresh-token payload, not the request.
      familyId: payload.familyId,
      actorType: payload.actorType,
      actorUserId: payload.actorType === 'USER' ? payload.sub : undefined,
      action: 'auth.logout',
      entityType: payload.actorType === 'USER' ? 'User' : 'Device',
      entityId: payload.sub,
    });
  }

  /**
   * PHASE C. Best-effort re-read of the caller's current family role.
   *
   * Returns `undefined` when no membership can be found — which makes the
   * successor token carry NO role claim, which `principalRoleFromToken()`
   * degrades to `PARENT`. That is the fail-safe direction: a user whose
   * membership row has vanished cannot end up holding OWNER.
   */
  private async currentFamilyRole(
    userId: string,
  ): Promise<IAuthenticatedUser['familyRole'] | undefined> {
    const membership = await this.userRepository.findPrimaryFamilyMembership(userId);
    if (!membership) return undefined;
    return toFamilyRole(membership.role);
  }
}
