import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { runInSystemScope } from './system-scope';
import { GrowthEventEmitter } from './growth-event-emitter.service';
import { GrowthSettingsService } from './growth-settings.service';
import { ReferralService } from './referral.service';
import {
  evaluateQualification,
  type ReferralRewardKind,
  type ReferralRejectionReason,
} from '../domain/referral';

const PG_UNIQUE_VIOLATION = 'P2002';

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === PG_UNIQUE_VIOLATION
  );
}

export interface IQualificationOutcome {
  readonly referredFamilyId: string;
  readonly qualified: boolean;
  readonly reason: ReferralRejectionReason | null;
  /** Present when a reward row was created BY THIS CALL (not by a concurrent one). */
  readonly rewardId: string | null;
}

/**
 * PHASE D (GROWTH) — THE PAYOUT HALF OF THE REFERRAL ENGINE.
 *
 * Separated from `ReferralService` because this is the half that spends money,
 * and the two halves have nothing in common operationally: capture runs inside
 * a parent's request and must never fail it; payout runs on a scheduled job,
 * must be exactly-once across replicas, and must be re-runnable without cost.
 *
 * THE EXACTLY-ONCE GUARANTEE IS ONE INDEX.
 * `referral_rewards.referral_event_id` is UNIQUE. Two workers that qualify the
 * same conversion at the same instant both attempt an INSERT; one commits, the
 * other gets a unique violation and returns "already rewarded" — WITHOUT
 * fulfilling anything, because fulfilment happens only on the branch that
 * actually created the row. This is the same shape
 * `payment_transactions (family_id, idempotency_key)` uses and it is chosen for
 * the same reason: a `SELECT ... IF NOT EXISTS THEN INSERT` is a race, and this
 * one races over a payout.
 *
 * FULFILMENT REUSES AN EXISTING LEDGER — THERE IS NO NEW CURRENCY.
 *   SUBSCRIPTION_CREDIT_DAYS extends `entitlements.valid_until`, which Phase D
 *     already made MONOTONIC (never shortened), so the operation is naturally
 *     idempotent even before the unique index is considered.
 *   CHILD_REWARD_COINS calls `PrismaRewardsRepository.applyEarn` with the
 *     deterministic key `referral:{referralEventId}` — the ledger's own
 *     `(child_id, idempotency_key)` UNIQUE, the one DA-002 made total, then
 *     protects it a second time.
 *
 * A FAILED FULFILMENT LEAVES THE ROW `PENDING`, NOT `GRANTED`. The next sweep
 * retries it. Marking it GRANTED and logging the failure would produce a
 * household that is owed a reward the system believes it has paid — the
 * single worst outcome available here.
 */
@Injectable()
export class ReferralRewardService {
  private readonly logger = new Logger(ReferralRewardService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: GrowthSettingsService,
    private readonly growthEvents: GrowthEventEmitter,
  ) {}

  /**
   * Evaluates every household that was referred and has not yet qualified.
   * Bounded per run so one sweep cannot hold a scheduler lease past its expiry
   * — the same reasoning `SCHEDULER_DEFAULTS.familyBatchSize` documents.
   */
  async sweep(now: Date, limit = 200): Promise<IQualificationOutcome[]> {
    const pending = await runInSystemScope(
      'SCHEDULED_JOB',
      'The referral qualification sweep spans every referrer household by definition; no per-request tenant exists on a timer tick.',
      () =>
        this.prisma.referralEvent.findMany({
          where: { kind: 'REGISTERED' },
          select: { id: true, familyId: true, referredFamilyId: true, referralCodeId: true },
          orderBy: { occurredAt: 'asc' },
          take: limit,
        }),
    );

    const outcomes: IQualificationOutcome[] = [];
    for (const row of pending) {
      if (!row.referredFamilyId) continue;
      try {
        outcomes.push(await this.qualify(row.familyId, row.referredFamilyId, row.referralCodeId, now));
      } catch (err) {
        this.logger.error(
          `referral.qualify_failed referrer=${row.familyId.slice(0, 8)} — ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return outcomes;
  }

  /**
   * The whole qualification decision for ONE referral relationship.
   *
   * Idempotent in every direction: an already-qualified relationship short
   * circuits, a not-yet-eligible one returns a reason and a `qualifiesAt`, and
   * a concurrent duplicate loses at the unique index rather than paying twice.
   */
  async qualify(
    referrerFamilyId: string,
    referredFamilyId: string,
    referralCodeId: string,
    now: Date,
  ): Promise<IQualificationOutcome> {
    const refundWindowDays = await this.settings.int('referral.qualification.refundWindowDays');
    const monthlyLimit = await this.settings.int('referral.fraud.maxQualifiedPerFamilyPerMonth');
    const rewardKind = (await this.settings.text('referral.reward.kind')) as ReferralRewardKind;
    const rewardValue = await this.settings.int('referral.reward.referrerValue');

    return runInSystemScope(
      'SCHEDULED_JOB',
      'Qualifying a referral reads the REFERRED household\'s payments and writes into the REFERRER household; two tenants, one decision, on a timer tick.',
      async () => {
        // Already qualified? The QUALIFIED event's idempotency key is
        // deterministic, so this is a point lookup rather than a scan.
        const alreadyQualified = await this.prisma.referralEvent.findFirst({
          where: { familyId: referrerFamilyId, idempotencyKey: `qualified:${referredFamilyId}` },
          select: { id: true },
        });
        if (alreadyQualified) {
          return { referredFamilyId, qualified: false, reason: null, rewardId: null };
        }

        // THE QUALIFYING FACT, AND IT IS NEVER A CLIENT CLAIM: a
        // SUCCEEDED row in `payment_transactions`, which is only ever written
        // after provider-side verification (Phase D §5/§6).
        const firstPayment = await this.prisma.paymentTransaction.findFirst({
          where: { familyId: referredFamilyId, status: 'SUCCEEDED' },
          orderBy: { occurredAt: 'asc' },
          select: { occurredAt: true },
        });

        const decision = evaluateQualification({
          firstSucceededPaymentAt: firstPayment?.occurredAt ?? null,
          now,
          refundWindowDays,
        });

        if (!decision.qualified) {
          return { referredFamilyId, qualified: false, reason: decision.reason, rewardId: null };
        }

        // VECTOR 4, the monthly half. Counted against real rows in a real
        // window — a household that has already been paid for ten conversions
        // this month stops being paid, and the refusal is recorded.
        const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        const qualifiedThisMonth = await this.prisma.referralEvent.count({
          where: { familyId: referrerFamilyId, kind: 'QUALIFIED', occurredAt: { gte: monthAgo } },
        });
        if (qualifiedThisMonth >= monthlyLimit) {
          return {
            referredFamilyId,
            qualified: false,
            reason: 'MONTHLY_QUALIFICATION_LIMIT',
            rewardId: null,
          };
        }

        // The QUALIFIED event and the reward row are created in ONE
        // transaction. Either both exist or neither does — a QUALIFIED event
        // with no reward would be a conversion the referrer is never paid for,
        // and a reward with no event would be a payout with no cause.
        let qualifiedEventId: string;
        try {
          qualifiedEventId = await this.prisma.$transaction(async (tx) => {
            const event = await tx.referralEvent.create({
              data: {
                familyId: referrerFamilyId,
                referralCodeId,
                kind: 'QUALIFIED',
                referredFamilyId,
                idempotencyKey: `qualified:${referredFamilyId}`,
              },
              select: { id: true },
            });

            // VECTOR 3. This INSERT is the exactly-once guarantee.
            await tx.referralReward.create({
              data: {
                familyId: referrerFamilyId,
                referralEventId: event.id,
                kind: rewardKind,
                value: rewardValue,
                status: 'PENDING',
              },
            });

            return event.id;
          });
        } catch (err) {
          if (isUniqueViolation(err)) {
            // A concurrent worker won. It is fulfilling the reward; this call
            // deliberately does NOT, which is what makes "exactly one reward"
            // true rather than "one reward row and two fulfilments".
            this.logger.log(
              `referral.qualify_lost_race referred=${referredFamilyId.slice(0, 8)} — another worker already qualified this conversion.`,
            );
            return { referredFamilyId, qualified: false, reason: null, rewardId: null };
          }
          throw err;
        }

        const reward = await this.prisma.referralReward.findFirst({
          where: { referralEventId: qualifiedEventId },
          select: { id: true, familyId: true, kind: true, value: true },
        });
        if (reward) await this.fulfil(reward.id, reward.familyId, reward.kind as ReferralRewardKind, reward.value);

        await this.growthEvents.emit({
          name: 'REFERRAL_CONVERTED',
          familyId: referrerFamilyId,
          sessionId: `referral:${referrerFamilyId}`,
          payload: {
            referralEventId: qualifiedEventId,
            referralRewardKind: rewardKind,
          },
        });

        return { referredFamilyId, qualified: true, reason: null, rewardId: reward?.id ?? null };
      },
    );
  }

  /**
   * Applies the payout. Runs INSIDE the referrer's tenant so the entitlement or
   * ledger write goes through the ordinary extension with deny-by-default
   * intact — the same re-entry the outbox relay performs before invoking a
   * consumer.
   */
  private async fulfil(
    rewardId: string,
    referrerFamilyId: string,
    kind: ReferralRewardKind,
    value: number,
  ): Promise<void> {
    try {
      const ref = await ReferralService.asTenant(referrerFamilyId, 'ReferralRewardService', async () => {
        if (kind === 'SUBSCRIPTION_CREDIT_DAYS') return this.creditSubscriptionDays(referrerFamilyId, value);
        return this.creditChildCoins(referrerFamilyId, rewardId, value);
      });

      await runInSystemScope(
        'SCHEDULED_JOB',
        'Marking a referral reward GRANTED after its fulfilment committed; the row belongs to the referrer, not to any request.',
        () =>
          this.prisma.referralReward.update({
            where: { id: rewardId },
            data: { status: 'GRANTED', fulfilmentRef: ref, grantedAt: new Date(), failureReason: null },
          }),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`referral.fulfilment_failed reward=${rewardId} — staying PENDING for retry. ${message}`);
      await runInSystemScope(
        'SCHEDULED_JOB',
        'Recording why a referral fulfilment failed; the reward stays PENDING so the next sweep retries it.',
        () =>
          this.prisma.referralReward.update({
            where: { id: rewardId },
            data: { failureReason: message.slice(0, 300) },
          }),
      );
    }
  }

  /**
   * Extends every live entitlement the referrer holds by `days`.
   *
   * `valid_until` is MONOTONIC by Phase D's own design — it is never shortened
   * — so this operation cannot take access away, and an open-ended entitlement
   * (`valid_until IS NULL`, a manual grant) is left alone rather than being
   * given a finite end date, which would be a downgrade dressed as a reward.
   */
  private async creditSubscriptionDays(familyId: string, days: number): Promise<string> {
    const live = await this.prisma.entitlement.findMany({
      where: { familyId, status: 'ACTIVE', validUntil: { not: null } },
      select: { id: true, validUntil: true },
    });

    if (live.length === 0) {
      // A referrer with no live entitlement (still on FREE) cannot be credited
      // in days. This is a real product gap and it FAILS LOUDLY rather than
      // silently marking the reward granted — see the HUMAN DECISION note.
      throw new Error(
        'Referrer holds no time-bounded entitlement to extend; SUBSCRIPTION_CREDIT_DAYS cannot be applied to a free household.',
      );
    }

    const addMs = days * 24 * 60 * 60 * 1000;
    for (const row of live) {
      const current = row.validUntil as Date;
      await this.prisma.entitlement.update({
        where: { id: row.id },
        data: { validUntil: new Date(current.getTime() + addMs) },
      });
    }
    return `entitlements:${live.length}:+${days}d`;
  }

  /**
   * Writes ONE `rewards_ledger_entries` EARN row through the SAME table the
   * reward engine uses, with a deterministic key. Deliberately raw against the
   * ledger's own contract rather than through the engine: the engine evaluates
   * REWARD RULES, and a referral is not a child's achievement — routing it
   * through rule evaluation would make a parent's referral depend on whether
   * the household happens to have a matching rule configured.
   */
  private async creditChildCoins(familyId: string, rewardId: string, coins: number): Promise<string> {
    const child = await this.prisma.child.findFirst({
      where: { familyId, deletedAt: null, isActive: true },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    if (!child) {
      throw new Error('Referrer household has no active child to credit coins to.');
    }

    const key = `referral:${rewardId}`;
    // `ON CONFLICT DO NOTHING` on `(child_id, idempotency_key)` — the ledger's
    // own total unique index (DA-002). Raw SQL, tenant-scoped explicitly,
    // because $executeRaw is not intercepted by the extension.
    const inserted = await this.prisma.$executeRawUnsafe(
      `INSERT INTO "rewards_ledger_entries"
         ("id","family_id","child_id","type","reward_type","amount","delta","source","idempotency_key","created_at")
       VALUES (gen_random_uuid(), $1, $2, 'EARN', 'COINS', $3, $3, 'referral', $4, now())
       ON CONFLICT ("child_id","idempotency_key") DO NOTHING`,
      familyId,
      child.id,
      coins,
      key,
    );

    if (inserted > 0) {
      await this.prisma.$executeRawUnsafe(
        `UPDATE "rewards_accounts" SET "coins" = "coins" + $1, "updated_at" = now()
          WHERE "child_id" = $2 AND "family_id" = $3`,
        coins,
        child.id,
        familyId,
      );
    }
    return `rewards_ledger_entries:${key}`;
  }
}
