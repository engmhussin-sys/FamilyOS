import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { GrowthEventEmitter } from './growth-event-emitter.service';
import { GrowthSettingsService } from './growth-settings.service';
import { evaluateActivation, type IActivationDecision } from '../domain/activation';
import type { CompletionKind } from '../../../shared/events/completion-event';

const PG_UNIQUE_VIOLATION = 'P2002';

export interface IActivationAttempt {
  readonly familyId: string;
  readonly childId: string;
  readonly completionKind: CompletionKind;
  readonly grantCount: number;
  readonly occurredAt: Date;
}

export interface IActivationResult {
  readonly activated: boolean;
  readonly decision: IActivationDecision | null;
  readonly alreadyActivated: boolean;
}

/**
 * PHASE D (GROWTH) — INSTRUMENTS `CHILD_COMPLETES_FIRST_MEANINGFUL_GOAL`.
 *
 * The definition lives in `domain/activation.ts` as a pure function; this class
 * is only the thing that fetches its three inputs and writes the row.
 *
 * IT IS DRIVEN BY `REWARD_GRANTED`, WHICH IS THE POINT. That domain event has
 * exactly one producer (`RewardsCompletionConsumer`) and is emitted only after
 * the LEDGER confirms a grant. So activation cannot be self-declared by a
 * device, cannot be triggered by a completion that was rejected, and cannot be
 * triggered by a duplicate — every one of those defences already exists on the
 * reward path and this metric inherits all of them for free. Building a second
 * signal would have meant re-deriving all of them, badly.
 *
 * `childId` IS READ AND THEN THROWN AWAY. It is needed for exactly one thing —
 * gate 3, "was this child added long enough ago that this is not a
 * demonstration" — and it does NOT reach the activation row or the growth
 * event. CONTEXT §3 principle 8: the metric needs to know that A child did
 * something meaningful, never which one.
 */
@Injectable()
export class ActivationService {
  private readonly logger = new Logger(ActivationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: GrowthSettingsService,
    private readonly growthEvents: GrowthEventEmitter,
  ) {}

  /**
   * Evaluates one candidate. Runs under whatever tenant context the caller
   * established — the domain-event bridge is invoked by the outbox relay, which
   * has already re-entered `runWithTenant({ familyId })`, so every read below
   * is scoped to that household by the extension rather than by a `where`
   * clause somebody had to remember.
   */
  async evaluate(attempt: IActivationAttempt): Promise<IActivationResult> {
    const existing = await this.prisma.familyActivation.findFirst({
      where: { familyId: attempt.familyId },
      select: { id: true },
    });
    if (existing) return { activated: false, decision: null, alreadyActivated: true };

    const [family, child, minMinutes] = await Promise.all([
      this.prisma.family.findFirst({
        where: { id: attempt.familyId },
        select: { createdAt: true },
      }),
      this.prisma.child.findFirst({
        where: { id: attempt.childId },
        select: { createdAt: true },
      }),
      this.settings.int('activation.minMinutesAfterChildCreated'),
    ]);

    if (!family || !child) {
      // Unreachable through the event path (the reward that caused this was
      // granted to a child of this family moments ago). Logged rather than
      // thrown: a missing row here must not fail the consumer and dead-letter a
      // REWARD_GRANTED message whose reward has already been paid.
      this.logger.warn(
        `activation.rows_missing family=${attempt.familyId.slice(0, 8)} — activation not evaluated.`,
      );
      return { activated: false, decision: null, alreadyActivated: false };
    }

    const decision = evaluateActivation(
      {
        familyId: attempt.familyId,
        completionKind: attempt.completionKind,
        grantCount: attempt.grantCount,
        childCreatedAt: child.createdAt,
        occurredAt: attempt.occurredAt,
        familyCreatedAt: family.createdAt,
      },
      minMinutes,
    );

    if (!decision.qualifies || decision.timeToValueMinutes === null) {
      return { activated: false, decision, alreadyActivated: false };
    }

    const countryCode = await this.countryOf(attempt.familyId);

    try {
      await this.prisma.familyActivation.create({
        data: {
          familyId: attempt.familyId,
          ruleVersion: decision.ruleVersion,
          completionKind: attempt.completionKind,
          occurredAt: attempt.occurredAt,
          timeToValueMinutes: decision.timeToValueMinutes,
          countryCode,
        },
      });
    } catch (err) {
      // GATE 4, decided by `family_activations_family_id_key`. Two concurrent
      // qualifying completions both reach here; one commits, the other reads
      // this branch and emits nothing. That is the whole "exactly once".
      if (typeof err === 'object' && err !== null && 'code' in err && (err as { code?: unknown }).code === PG_UNIQUE_VIOLATION) {
        return { activated: false, decision, alreadyActivated: true };
      }
      throw err;
    }

    await this.growthEvents.emit({
      name: 'CHILD_COMPLETES_FIRST_MEANINGFUL_GOAL',
      familyId: attempt.familyId,
      sessionId: `activation:${attempt.familyId}`,
      payload: {
        completionKind: attempt.completionKind,
        timeToValueMinutes: decision.timeToValueMinutes,
        meaningfulGoalRule: decision.ruleVersion,
        countryCode: countryCode ?? undefined,
      },
    });

    this.logger.log(
      `growth.activation family=${attempt.familyId.slice(0, 8)} rule=${decision.ruleVersion} ttv=${decision.timeToValueMinutes}m`,
    );

    return { activated: true, decision, alreadyActivated: false };
  }

  /**
   * The country a household is attributed to, for slicing activation by market.
   *
   * F1 PUT `families.country_code` AT THE FRONT of the order, and the ordering
   * is now stated once, in `domain/country-attribution.ts`, so the country
   * STAMPED on an activation row is resolved by the same rule the queries that
   * COUNT those rows use. Server record first, then the untrusted marketing
   * label, then the subscription's country.
   *
   * `null` when none of the three exists — an honest "unknown market", never a
   * defaulted 'EG'.
   */
  private async countryOf(familyId: string): Promise<string | null> {
    const family = await this.prisma.family.findUnique({
      where: { id: familyId },
      select: { countryCode: true },
    });
    if (family?.countryCode) return family.countryCode;

    const attribution = await this.prisma.acquisitionAttribution.findFirst({
      where: { familyId },
      select: { countryCode: true },
    });
    if (attribution?.countryCode) return attribution.countryCode;

    const subscription = await this.prisma.subscription.findFirst({
      where: { familyId },
      select: { countryCode: true },
    });
    return subscription?.countryCode ?? null;
  }
}
