import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';

import { AuditService } from '../../../audit/application/audit.service';
import { USER_REPOSITORY, type IUserRepository } from '../../../auth/application/ports/auth.repository.ports';
import { ENTITLEMENT_KEYS, type EntitlementKey, type SubscriptionPlanTier } from '../../domain/billing.types';
import { BILLING_REPOSITORY, type IBillingRepository } from '../ports/billing.repository.port';
import { EntitlementService } from './entitlement.service';

/**
 * ===========================================================================
 * COMPING A PLAN — the operator gesture, with the two things that make it safe.
 * ===========================================================================
 *
 * WHY THIS EXISTS. A tester, a pilot household, a support apology and a partner
 * campaign all need the same thing: full features on a household that has paid
 * nothing. Without a named way to do it, that need is met by someone editing
 * `subscriptions` by hand in a SQL console — untraceable, unreversible, and
 * indistinguishable afterwards from a real payment.
 *
 * IT INVENTS NO MECHANISM. `EntitlementService.grantManual` has existed since
 * Phase D and its own docstring says «its callers are behind
 * InternalAdminGuard» — a sentence that was not true, because it had no callers
 * at all. This is that caller. Nothing about how entitlement is decided changes:
 * `EntitlementService.hasFeature` remains the single authority, an
 * `entitlements` row still outranks the `subscriptions` fallback, and
 * `revokeAll` still ends a grant exactly as it ends a refunded purchase.
 *
 * ===================== THE TWO THINGS THAT MAKE IT SAFE ====================
 *
 * 1. IT EXPIRES BY DEFAULT. `grantManual` accepts `validUntil: null` — an
 *    open-ended grant — and this service will not pass one. A comp that never
 *    ends is a household that silently stops being a customer, and nobody
 *    notices for a year. `days` is required, bounded, and the resulting date is
 *    returned so the operator sees exactly when it lapses.
 *
 * 2. IT IS AUDITED, NOT JUST LOGGED. `grantManual` writes a log line, which is
 *    gone with the container. This writes an `audit_logs` row tied to the
 *    family, so "why does this household have PREMIUM without a payment" is
 *    answerable months later, by query, with the operator's stated reason
 *    beside it. `actorType: 'SYSTEM'` is honest: the platform operator is not a
 *    `users` row and has no `actorUserId` to record — see `InternalAdminGuard`,
 *    which deliberately writes no `request.user`.
 *
 * ============================ AND HOW TO REMOVE IT =========================
 *
 * The whole feature is this file, `BillingOperationsController`, their two DTOs
 * and their tests. Deleting those four things removes it completely and leaves
 * `EntitlementService` exactly as it was — there is no schema change to undo,
 * because a comp is an ordinary `entitlements` row with `source = 'MANUAL'`.
 * Grants already made survive as data and expire on their own; to end them
 * early, revoke first.
 */
@Injectable()
export class OperatorGrantService {
  private readonly logger = new Logger(OperatorGrantService.name);

  /**
   * The longest comp this service will write in one call. Not a policy about
   * what a business may give away — it is a blast radius. An operator who
   * fat-fingers `days` should overshoot by weeks, not by decades, and a longer
   * grant is two deliberate calls rather than one typo.
   */
  static readonly MAX_DAYS = 400;

  constructor(
    private readonly entitlements: EntitlementService,
    private readonly audit: AuditService,
    @Inject(USER_REPOSITORY) private readonly users: IUserRepository,
    @Inject(BILLING_REPOSITORY) private readonly billing: IBillingRepository,
  ) {}

  /**
   * Email, not family id, is the identifier an operator actually has: it is
   * what the person wrote in the support message. The family is resolved from
   * it SERVER-SIDE, so no caller ever names a `familyId` — the same rule every
   * other surface in this codebase follows, and the one CI RULE 3 enforces on
   * request DTOs.
   */
  private async resolveFamily(email: string): Promise<{ familyId: string; userId: string }> {
    const user = await this.users.findByEmail(email.trim().toLowerCase());
    /**
     * A user does NOT carry a `familyId`: membership is a `family_members` row,
     * so a person can belong to more than one household. `findPrimaryFamilyMembership`
     * is the same lookup `AuthService.login` performs to decide which family a
     * token is minted for — reused rather than reimplemented, so an operator
     * grant can never land on a different household from the one that person
     * signs into.
     */
    const membership = user ? await this.users.findPrimaryFamilyMembership(user.id) : null;
    if (!user || !membership) {
      // The same answer for "no such account" and "an account with no family",
      // because an operator surface that distinguishes them is an account
      // oracle for anyone who gets hold of the key.
      throw new NotFoundException({
        code: 'FAMILY_NOT_FOUND',
        message: 'No household is associated with that email address.',
      });
    }
    return { familyId: membership.familyId, userId: user.id };
  }

  async describe(email: string) {
    const { familyId } = await this.resolveFamily(email);
    const state = await this.entitlements.describe(familyId);
    return { familyId, ...state };
  }

  async grant(input: {
    email: string;
    planTier: SubscriptionPlanTier;
    days: number;
    reason: string;
  }) {
    const { familyId, userId } = await this.resolveFamily(input.email);

    /**
     * A GRANT THAT GRANTS NOTHING MUST NOT ANSWER 200 — and this branch was
     * written because the first version of this service did exactly that.
     *
     * `grantManual` delegates to `grantForPlan`, which looks the tier up in
     * `plan_definitions` and writes one entitlement row per feature listed
     * there. That table is documented as «seeded once» and NO MIGRATION SEEDS
     * IT — on a database built from the migration history it is empty. So the
     * call succeeded, wrote zero rows, and returned `features: []`: an operator
     * would have read 200, told a tester they were upgraded, and the paywall
     * would have refused them exactly as before.
     *
     * Checked here rather than deeper down because this is the only surface
     * where a human is waiting for an answer about a specific household.
     */
    const plan = await this.billing.findPlanByTier(input.planTier);
    if (!plan || plan.features.length === 0) {
      throw new ConflictException({
        code: 'PLAN_CATALOGUE_EMPTY',
        message:
          `No plan definition exists for tier ${input.planTier}, so granting it would write nothing. ` +
          `Define the plan catalogue (plan_definitions), or grant explicit features instead.`,
        details: { availableFeatureKeys: ENTITLEMENT_KEYS },
      });
    }

    const validUntil = new Date(Date.now() + input.days * 24 * 60 * 60 * 1000);
    const records = await this.entitlements.grantManual({
      familyId,
      planTier: input.planTier,
      validUntil,
      // The household's own owner is recorded as the grant's subject. The
      // OPERATOR is not a user row and cannot be recorded as one; the audit
      // entry below is where the operator action is written down.
      grantedByUserId: userId,
    });

    await this.audit.record({
      familyId,
      actorType: 'SYSTEM',
      action: 'billing.operator_grant',
      entityType: 'entitlement',
      entityId: familyId,
      metadata: {
        planTier: input.planTier,
        days: input.days,
        validUntil: validUntil.toISOString(),
        reason: input.reason,
        featureCount: records.length,
      },
    });

    this.logger.warn(
      `OPERATOR GRANT: ${input.planTier} for ${input.days}d on family ${familyId}. Reason: ${input.reason}`,
    );

    return {
      familyId,
      planTier: input.planTier,
      validUntil: validUntil.toISOString(),
      features: records.map((record) => record.featureKey),
    };
  }

  /**
   * GRANT EXPLICIT FEATURES — the path that needs no plan catalogue.
   *
   * The six entitlement keys are a CLOSED VOCABULARY IN CODE
   * (`ENTITLEMENT_KEYS`), not business data: they exist whether or not anyone
   * has decided what a plan costs. So a tester can be given exactly the
   * capabilities they need to test, on a fresh database, without inventing a
   * price — and inventing a price is precisely what seeding a plan catalogue
   * from here would be.
   *
   * `planTier` is still recorded on each row, because `entitlements.plan_tier`
   * is not nullable and an operator grant should say which tier it was standing
   * in for. It does not decide anything: `hasFeature` reads the feature rows.
   */
  async grantFeatures(input: {
    email: string;
    features: EntitlementKey[];
    planTier: SubscriptionPlanTier;
    days: number;
    reason: string;
  }) {
    const { familyId } = await this.resolveFamily(input.email);
    const validUntil = new Date(Date.now() + input.days * 24 * 60 * 60 * 1000);
    const validFrom = new Date();

    const records = [];
    for (const featureKey of input.features) {
      records.push(
        await this.entitlements.grantFeature({
          familyId,
          featureKey,
          planTier: input.planTier,
          validFrom,
          validUntil,
        }),
      );
    }

    await this.audit.record({
      familyId,
      actorType: 'SYSTEM',
      action: 'billing.operator_grant',
      entityType: 'entitlement',
      entityId: familyId,
      metadata: {
        planTier: input.planTier,
        features: input.features,
        days: input.days,
        validUntil: validUntil.toISOString(),
        reason: input.reason,
        featureCount: records.length,
      },
    });

    this.logger.warn(
      `OPERATOR GRANT (explicit features): ${input.features.join(', ')} for ${input.days}d ` +
        `on family ${familyId}. Reason: ${input.reason}`,
    );

    return {
      familyId,
      planTier: input.planTier,
      validUntil: validUntil.toISOString(),
      features: records.map((record) => record.featureKey),
    };
  }

  async revoke(input: { email: string; reason: string }) {
    const { familyId } = await this.resolveFamily(input.email);

    /**
     * `revokeAll` — the SAME method a refund uses, deliberately. A separate
     * "un-comp" path would be a second way to end an entitlement, and the two
     * would drift; this repository has already paid for two services that
     * disagreed about what "entitled" means.
     *
     * It revokes every grant on the family, including any from a real payment.
     * On a household that has genuinely paid that is the wrong gesture, and the
     * count returned is what tells the operator it happened.
     */
    const revoked = await this.entitlements.revokeAll(familyId, `operator: ${input.reason}`);

    await this.audit.record({
      familyId,
      actorType: 'SYSTEM',
      action: 'billing.operator_revoke',
      entityType: 'entitlement',
      entityId: familyId,
      metadata: { reason: input.reason, revokedCount: revoked },
    });

    this.logger.warn(`OPERATOR REVOKE: ${revoked} entitlement(s) on family ${familyId}. Reason: ${input.reason}`);

    return { familyId, revokedCount: revoked };
  }
}
