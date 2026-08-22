import { Inject, Injectable, Logger } from '@nestjs/common';

import { AuditService } from '../../../audit/application/audit.service';
import { BILLING_REPOSITORY, type IBillingRepository } from '../ports/billing.repository.port';
import type { EntitlementKey, IPlanDefinition, SubscriptionPlanTier } from '../../domain/billing.types';

/**
 * ===========================================================================
 * THE PLAN CATALOGUE — the table the whole commercial side reads, and which
 * nothing has ever written.
 * ===========================================================================
 *
 * WHAT WAS WRONG. `plan_definitions` is described in `schema.prisma` as «one
 * row per SubscriptionPlan enum value, seeded once, admin-editable later».
 * Neither half was true: no migration seeds it, and no surface edits it. On
 * every database built from this repository's migration history it is EMPTY,
 * and the consequences are not cosmetic:
 *
 *   · `EntitlementService.hasFeature` falls back to the family's plan tier,
 *     looks the tier up here, finds nothing, and answers FALSE. Every paid
 *     feature is therefore locked for every household, including free ones —
 *     the FREE tier's own feature list lives in this table too.
 *   · `grantForPlan` iterates `plan.features` to write entitlement rows. With
 *     no plan it writes none, so a REAL VERIFIED PURCHASE grants nothing.
 *   · which is why the operator grant surface had to answer
 *     `PLAN_CATALOGUE_EMPTY` rather than pretend.
 *
 * NO MIGRATION SEEDS IT HERE EITHER, AND THAT IS DELIBERATE. A seed would have
 * to contain prices, and prices are a business decision belonging to the person
 * who owns the product. Inventing «PREMIUM = 4999 EGP» to make a table
 * non-empty would put a number nobody chose into the one place the whole
 * commercial side reads it from. So the catalogue starts empty and this service
 * lets its owner fill it — which is what «admin-editable» was supposed to mean.
 *
 * EVERY WRITE IS AUDITED, with no `familyId`: a plan is global, and attributing
 * a catalogue change to a household would be a lie about who it affected.
 */
@Injectable()
export class PlanCatalogueService {
  private readonly logger = new Logger(PlanCatalogueService.name);

  constructor(
    @Inject(BILLING_REPOSITORY) private readonly billing: IBillingRepository,
    private readonly audit: AuditService,
  ) {}

  /**
   * The catalogue as it is, plus the two things an operator needs to know
   * ABOUT it — whether it is empty at all, and which entitlement keys exist to
   * choose from. Both are read from code and the database rather than typed
   * into a form's help text, so neither can drift from the truth.
   */
  async list(): Promise<{
    plans: IPlanDefinition[];
    isEmpty: boolean;
    availableFeatures: readonly EntitlementKey[];
  }> {
    const plans = await this.billing.findAllPlans();
    const { ENTITLEMENT_KEYS } = await import('../../domain/billing.types');
    return { plans, isEmpty: plans.length === 0, availableFeatures: ENTITLEMENT_KEYS };
  }

  async upsert(input: {
    tier: SubscriptionPlanTier;
    name: string;
    priceCents: number;
    currency: string;
    billingIntervalMonths: number;
    features: EntitlementKey[];
    isActive: boolean;
  }): Promise<IPlanDefinition> {
    const before = await this.billing.findPlanByTier(input.tier);
    const plan = await this.billing.upsertPlan({ ...input, features: [...input.features] });

    await this.audit.record({
      actorType: 'SYSTEM',
      action: before ? 'billing.plan_updated' : 'billing.plan_created',
      entityType: 'plan_definition',
      entityId: plan.id,
      metadata: {
        tier: input.tier,
        name: input.name,
        priceCents: input.priceCents,
        currency: input.currency,
        billingIntervalMonths: input.billingIntervalMonths,
        features: input.features,
        isActive: input.isActive,
        // What it replaced, so a catalogue change is reversible by reading the
        // trail rather than by remembering.
        previous: before
          ? {
              name: before.name,
              priceCents: before.priceCents,
              currency: before.currency,
              features: before.features,
              isActive: before.isActive,
            }
          : null,
      },
    });

    this.logger.warn(
      `PLAN CATALOGUE ${before ? 'UPDATED' : 'CREATED'}: ${input.tier} — ` +
        `${input.priceCents} ${input.currency} / ${input.billingIntervalMonths}mo, ` +
        `features: ${input.features.join(', ') || 'none'}`,
    );

    return plan;
  }
}
