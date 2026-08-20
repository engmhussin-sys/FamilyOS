import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';

import { PrismaService } from '../../../common/prisma/prisma.service';
import { runInSystemScope } from './system-scope';
import { runWithTenant } from '../../../common/tenancy/tenant-context';
import { GrowthEventEmitter } from './growth-event-emitter.service';
import { GrowthSettingsService } from './growth-settings.service';
import {
  DuplicateReferralError,
  REFERRAL_CODE_LENGTH,
  ReferralRateLimitError,
  SelfReferralError,
  UnknownReferralCodeError,
  assertNotSelfReferral,
  normaliseReferralCode,
  referralCodeFromBytes,
  type ReferralRejectionReason,
} from '../domain/referral';
import type { AcquisitionChannel } from '../domain/attribution';

/** Postgres' unique-violation SQLSTATE, and Prisma's code for the same thing. */
const PG_UNIQUE_VIOLATION = 'P2002';

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === PG_UNIQUE_VIOLATION
  );
}

export interface IReferralCodeView {
  readonly code: string;
  readonly isActive: boolean;
  readonly sentCount: number;
  readonly registeredCount: number;
  readonly qualifiedCount: number;
}

/**
 * PHASE D (GROWTH) — THE REFERRAL CAPTURE PATH.
 *
 * Everything here happens BEFORE any money moves: minting a household's code,
 * making a shareable link, recording that an invitation went out, and binding a
 * newly registered household to the referrer whose code it carried. The payout
 * half lives in `ReferralRewardService`, deliberately in a different class,
 * because the two run in completely different contexts (a parent's request vs a
 * scheduled job) and have completely different failure consequences.
 *
 * THE THREE PLACES THIS CLASS DELIBERATELY DOES NOT DECIDE ANYTHING:
 *
 *   - SELF-REFERRAL. `assertNotSelfReferral` produces a 409 with a sentence a
 *     parent can read. It is NOT what makes self-referral impossible — the
 *     `referral_events_no_self_referral` CHECK is. If this function were
 *     deleted the attack would still fail, at the database, with a 500. That is
 *     the correct ordering of guarantees.
 *   - DUPLICATE REFERRAL. Same: `referral_events_referred_family_uq` is the
 *     guarantee, the catch below is the manners.
 *   - THE VELOCITY LIMITS. They are counted against real rows rather than a
 *     Redis counter, because a limiter that resets on restart is not an audit
 *     trail, and «why did this household receive nine rewards» must be
 *     answerable from the database a year later.
 *
 * TENANCY. Three of these operations legitimately cross tenants and each says
 * so with a narrow `runAsSystemAsync`:
 *   1. resolving a code to its OWNER (the referred household cannot be allowed
 *      to read the referrer's row, but the server must);
 *   2. writing the REGISTERED event, whose tenant is the REFERRER while the
 *      request is being made by (or for) the REFERRED household;
 *   3. reading a family's own code during registration, before any tenant
 *      context exists.
 * Everything a parent reads about their OWN referrals runs under the ordinary
 * tenant extension with deny-by-default intact.
 */
@Injectable()
export class ReferralService {
  private readonly logger = new Logger(ReferralService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: GrowthSettingsService,
    private readonly growthEvents: GrowthEventEmitter,
  ) {}

  /**
   * The household's code, minted on first request and never changed.
   *
   * Collision handling is a retry loop with a hard bound rather than a
   * "generate and hope": at 2^40 codes a collision is vanishingly unlikely, and
   * a loop that could spin forever on a broken RNG is a worse bug than the one
   * it is guarding against.
   */
  async ensureCode(familyId: string, userId: string | null): Promise<string> {
    const existing = await this.prisma.referralCode.findFirst({
      where: { familyId },
      select: { code: true },
    });
    if (existing) return existing.code;

    for (let attempt = 0; attempt < 5; attempt++) {
      const code = referralCodeFromBytes(randomBytes(REFERRAL_CODE_LENGTH * 2));
      try {
        await this.prisma.referralCode.create({
          data: { familyId, code, createdByUserId: userId },
        });
        return code;
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        // Either the code collided (retry with a new one) or this family
        // already has a code because a concurrent request won the race — in
        // which case reading it is the right answer, not minting a second.
        const now = await this.prisma.referralCode.findFirst({
          where: { familyId },
          select: { code: true },
        });
        if (now) return now.code;
      }
    }
    throw new Error('Could not allocate a referral code after 5 attempts.');
  }

  /** A per-channel shareable link. One row per (code, channel), enforced. */
  async ensureLink(familyId: string, userId: string | null, channel: AcquisitionChannel, baseUrl: string): Promise<string> {
    const code = await this.ensureCode(familyId, userId);
    const codeRow = await this.prisma.referralCode.findFirst({
      where: { familyId },
      select: { id: true },
    });
    if (!codeRow) throw new Error('Referral code disappeared between allocation and read.');

    const url = `${baseUrl.replace(/\/+$/, '')}/r/${code}?ch=${channel.toLowerCase()}`;

    const existing = await this.prisma.referralLink.findFirst({
      where: { familyId, referralCodeId: codeRow.id, channel },
      select: { url: true },
    });
    if (existing) return existing.url;

    try {
      await this.prisma.referralLink.create({
        data: { familyId, referralCodeId: codeRow.id, channel, url },
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
    return url;
  }

  /**
   * Records that an invitation went out. VECTOR 4 (rapid abuse) is enforced
   * here, against real rows in a real day window.
   *
   * NOTE WHAT IS NOT STORED: no email address, no phone number. A referral log
   * that recorded who was invited would become a contact list of people who are
   * not our users, which is a privacy liability with no analytics value — the
   * channel is what a conversion rate is computed per, not the recipient.
   */
  async recordSent(familyId: string, userId: string | null, channel: AcquisitionChannel): Promise<void> {
    const code = await this.prisma.referralCode.findFirst({
      where: { familyId },
      select: { id: true, code: true },
    });
    if (!code) throw new UnknownReferralCodeError('(none for this family)');

    const maxPerDay = await this.settings.int('referral.fraud.maxSentPerFamilyPerDay');
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const sentToday = await this.prisma.referralEvent.count({
      where: { familyId, kind: 'SENT', occurredAt: { gte: since } },
    });

    if (sentToday >= maxPerDay) {
      // The refusal is RECORDED, not merely returned. A household hammering
      // the invite endpoint is a fraud signal, and a system that discards its
      // refusals cannot see one.
      await this.recordRejection(familyId, code.id, 'SEND_RATE_EXCEEDED', null);
      throw new ReferralRateLimitError(
        'SEND_RATE_EXCEEDED',
        `This family has already sent ${sentToday} invitations in the last 24 hours (limit ${maxPerDay}).`,
      );
    }

    await this.prisma.referralEvent.create({
      data: {
        familyId,
        referralCodeId: code.id,
        kind: 'SENT',
        channel,
        idempotencyKey: `sent:${channel}:${Date.now()}:${randomBytes(6).toString('hex')}`,
      },
    });

    await this.growthEvents.emit({
      name: 'REFERRAL_SENT',
      familyId,
      userId,
      sessionId: `referral:${familyId}`,
      payload: { channel, referralCode: code.code },
    });
  }

  /**
   * BINDS A NEWLY REGISTERED HOUSEHOLD TO THE REFERRER WHOSE CODE IT CARRIED.
   *
   * Called from inside registration, which runs under `AUTH_BOOTSTRAP` with no
   * tenant context — the referred family exists but nothing has established it
   * as the ambient tenant, and the row being written belongs to the REFERRER
   * anyway. Both facts are why the whole method runs under one narrow system
   * bypass rather than under the extension.
   *
   * NEVER THROWS TO THE CALLER. A bad or duplicated referral code must not fail
   * a registration; the household is created either way and simply is not
   * credited to anyone. The rejection is recorded when we know whom to record
   * it against.
   */
  async registerReferral(
    referredFamilyId: string,
    rawCode: string,
  ): Promise<{ bound: boolean; reason: ReferralRejectionReason | null }> {
    const code = normaliseReferralCode(rawCode);

    try {
      return await runInSystemScope(
        'AUTH_BOOTSTRAP',
        'Binding a just-registered household to a referrer: the code owner is a DIFFERENT tenant and registration has no ambient tenant context.',
        async () => {
          const codeRow = await this.prisma.referralCode.findUnique({
            where: { code },
            select: { id: true, familyId: true, isActive: true },
          });

          if (!codeRow) throw new UnknownReferralCodeError(code);
          if (!codeRow.isActive) {
            await this.recordRejection(codeRow.familyId, codeRow.id, 'INACTIVE_CODE', referredFamilyId);
            return { bound: false, reason: 'INACTIVE_CODE' as ReferralRejectionReason };
          }

          // VECTOR 1. The CHECK constraint is the guarantee; this is the
          // readable refusal, and it is recorded.
          try {
            assertNotSelfReferral(codeRow.familyId, referredFamilyId);
          } catch (err) {
            if (err instanceof SelfReferralError) {
              await this.recordRejection(codeRow.familyId, codeRow.id, 'SELF_REFERRAL', null);
              return { bound: false, reason: 'SELF_REFERRAL' as ReferralRejectionReason };
            }
            throw err;
          }

          try {
            // VECTOR 2. `referral_events_referred_family_uq` decides this, not
            // a preceding SELECT — two concurrent registrations carrying two
            // different codes race here and exactly one wins.
            await this.prisma.referralEvent.create({
              data: {
                familyId: codeRow.familyId,
                referralCodeId: codeRow.id,
                kind: 'REGISTERED',
                referredFamilyId,
                idempotencyKey: `registered:${referredFamilyId}`,
              },
            });
            return { bound: true, reason: null };
          } catch (err) {
            if (!isUniqueViolation(err)) throw err;
            await this.recordRejection(codeRow.familyId, codeRow.id, 'ALREADY_REFERRED', null);
            throw new DuplicateReferralError();
          }
        },
      );
    } catch (err) {
      if (err instanceof UnknownReferralCodeError) {
        return { bound: false, reason: 'UNKNOWN_CODE' };
      }
      if (err instanceof DuplicateReferralError) {
        return { bound: false, reason: 'ALREADY_REFERRED' };
      }
      this.logger.warn(
        `referral.bind_failed referred=${referredFamilyId.slice(0, 8)} — registration is unaffected. ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return { bound: false, reason: null };
    }
  }

  /**
   * A REJECTED row. `referredFamilyId` is passed as `null` for the two
   * rejections where recording it would itself be a leak or a constraint
   * violation: a SELF_REFERRAL row cannot carry it (the CHECK forbids it), and
   * an ALREADY_REFERRED row must not tell the second referrer which household
   * the first one claimed.
   */
  private async recordRejection(
    referrerFamilyId: string,
    referralCodeId: string,
    reason: ReferralRejectionReason,
    referredFamilyId: string | null,
  ): Promise<void> {
    try {
      await this.prisma.referralEvent.create({
        data: {
          familyId: referrerFamilyId,
          referralCodeId,
          kind: 'REJECTED',
          referredFamilyId,
          rejectionReason: reason,
          idempotencyKey: `rejected:${reason}:${referredFamilyId ?? 'anon'}:${Date.now()}:${randomBytes(4).toString('hex')}`,
        },
      });
    } catch (err) {
      this.logger.warn(
        `referral.rejection_not_recorded reason=${reason} — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * What a parent sees about their OWN referrals. Runs under the ordinary
   * tenant extension: every count below is filtered to the caller's family by
   * `tenant.extension.ts`, so passing another family's id returns that
   * family's... nothing, because the filter is injected rather than trusted.
   */
  async summaryFor(familyId: string, userId: string | null): Promise<IReferralCodeView> {
    const code = await this.ensureCode(familyId, userId);

    const [sentCount, registeredCount, qualifiedCount] = await Promise.all([
      this.prisma.referralEvent.count({ where: { familyId, kind: 'SENT' } }),
      this.prisma.referralEvent.count({ where: { familyId, kind: 'REGISTERED' } }),
      this.prisma.referralEvent.count({ where: { familyId, kind: 'QUALIFIED' } }),
    ]);

    return { code, isActive: true, sentCount, registeredCount, qualifiedCount };
  }

  /**
   * Runs `fn` as the given tenant. Exposed for `ReferralRewardService`, which
   * must write into the REFERRER's household from a scheduled job — the same
   * pattern the outbox relay uses when it re-enters a tenant before invoking a
   * consumer.
   */
  static asTenant<T>(familyId: string, actorId: string, fn: () => Promise<T>): Promise<T> {
    return runWithTenant({ familyId, actorType: 'SYSTEM', actorId }, fn);
  }
}
