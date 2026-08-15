import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { currentContext } from '../../../common/tenancy/tenant-context';

/**
 * §9.3's hard cut-off, in micro-cents (the unit `AiUsageLog` already stores).
 * $0.09 = 9 cents = 9,000,000 micro-cents. It is 150% of the $0.06 target, not
 * equal to it, because the target is an AVERAGE across families and a cap equal
 * to the average would cut off every family that is merely above the median.
 */
export const FAMILY_MONTHLY_BUDGET_MICRO_CENTS = 9_000_000;

export interface AiBudgetStatus {
  readonly familyId: string | null;
  readonly spentMicroCents: number;
  readonly limitMicroCents: number;
  readonly remainingMicroCents: number;
  readonly spentUsd: number;
  readonly limitUsd: number;
  readonly exhausted: boolean;
  /** ISO date of the first instant of the current calendar month, UTC. */
  readonly periodStart: string;
}

/**
 * B8 — THE SPEND CUT-OFF (PA-B-028 closed).
 *
 * Phase A's finding was precise and worth restating: cost control existed but
 * was OBSERVATIONAL. `AiUsageTrackingService` recorded every call and rolled it
 * up for an admin dashboard, and nothing anywhere ever asked "may I spend this"
 * BEFORE calling a provider. A number you can only read after the fact is a
 * report, not a budget, and CONTEXT §6's ≤ $0.06/family/month was therefore
 * unenforceable by construction.
 *
 * THE CHECK RUNS IN `FallbackAiProvider`, ONCE, BEFORE THE FIRST RING. Putting
 * it in each adapter would mean a new adapter silently opts out; putting it in
 * each caller would mean six copies and a seventh caller that forgets.
 *
 * WHAT EXHAUSTION DOES IS THE PRODUCT DECISION, NOT THE TECHNICAL ONE (§9.3):
 * «Degraded mode ≠ فشل». An over-budget family gets the FULL deterministic
 * card, with no error, no empty state, and no "AI unavailable" banner — the
 * only difference is the absence of the «صيغ بالذكاء الاصطناعي» badge. A cost
 * problem is ours, and showing it to a parent as a failure would be charging
 * them for our infrastructure decision.
 *
 * TENANCY IS FREE HERE. `AiUsageLog` is a `PLATFORM_ANNOTATED_MODEL`, so the
 * tenant extension already filters this read to the caller's own family and
 * already stamps `family_id` on every write. This service therefore contains no
 * `familyId` filter of its own — adding one would be a second, drift-prone
 * copy of a rule the extension enforces globally.
 */
@Injectable()
export class AiBudgetService {
  private readonly logger = new Logger(AiBudgetService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Calendar month, UTC, deliberately. This is a BILLING period, not a family's
   * day: `FamilyDateService` governs every question about what day it is for a
   * household (streaks, quiet hours, daily caps) and none of those are this.
   * Making the budget window family-local would mean 24 different month
   * boundaries for one invoice.
   */
  private periodStart(now: Date): Date {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
  }

  async status(now: Date = new Date()): Promise<AiBudgetStatus> {
    const ctx = currentContext();
    const familyId = ctx?.kind === 'TENANT' ? ctx.familyId : null;
    const start = this.periodStart(now);

    let spent = 0;
    try {
      const agg = await this.prisma.aiUsageLog.aggregate({
        _sum: { estimatedCostMicroCents: true },
        where: { createdAt: { gte: start } },
      });
      spent = agg._sum.estimatedCostMicroCents ?? 0;
    } catch (err) {
      // FAIL OPEN, AND SAY SO. A budget lookup that fails is an infrastructure
      // problem; refusing every AI call because we could not read a counter
      // would convert a database hiccup into a product outage, and the cap it
      // protects is $0.09. The opposite choice (fail closed) is right for the
      // SAFETY filter and wrong here, and the two are different files for
      // exactly this reason.
      this.logger.warn(
        `ai.budget.lookup_failed — proceeding without a cap for this call. ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      spent = 0;
    }

    const remaining = Math.max(0, FAMILY_MONTHLY_BUDGET_MICRO_CENTS - spent);
    return {
      familyId,
      spentMicroCents: spent,
      limitMicroCents: FAMILY_MONTHLY_BUDGET_MICRO_CENTS,
      remainingMicroCents: remaining,
      spentUsd: spent / 100_000_000,
      limitUsd: FAMILY_MONTHLY_BUDGET_MICRO_CENTS / 100_000_000,
      exhausted: spent >= FAMILY_MONTHLY_BUDGET_MICRO_CENTS,
      periodStart: start.toISOString(),
    };
  }

  /** The one question the provider chain asks. */
  async hasBudget(now: Date = new Date()): Promise<boolean> {
    const status = await this.status(now);
    if (status.exhausted) {
      this.logger.log(
        JSON.stringify({
          event: 'ai_budget_exhausted',
          familyId: status.familyId,
          spentUsd: status.spentUsd,
          limitUsd: status.limitUsd,
        }),
      );
    }
    return !status.exhausted;
  }
}
