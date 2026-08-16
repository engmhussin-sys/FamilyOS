import { Body, ConflictException, Controller, ForbiddenException, Get, Post, UseGuards } from '@nestjs/common';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { Throttle } from '@nestjs/throttler';

import { JwtAuthGuard } from '../../../auth/presentation/guards/jwt-auth.guard';
import { ParentSurface } from '../../../../common/authz/roles.decorator';
import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import type { IJwtPayload } from '../../../auth/domain/auth.types';
import { ReferralService } from '../../application/referral.service';
import { ReferralRateLimitError } from '../../domain/referral';
import { ACQUISITION_CHANNELS, type AcquisitionChannel } from '../../domain/attribution';

class RecordSentDto {
  @IsIn(ACQUISITION_CHANNELS)
  channel!: AcquisitionChannel;
}

class CreateLinkDto {
  @IsIn(ACQUISITION_CHANNELS)
  channel!: AcquisitionChannel;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  baseUrl?: string;
}

/**
 * PHASE D (GROWTH) — THE PARENT-FACING REFERRAL SURFACE.
 *
 * FOUR ROUTES, AND WHAT IS DELIBERATELY ABSENT FROM ALL OF THEM.
 *
 * There is NO endpoint by which a client can declare a conversion, credit a
 * referral, or name the household it referred. `POST /referral/sent` records
 * that an invitation went out on a channel and nothing more; the binding
 * happens inside registration from a code the new household carried, and the
 * qualification happens on a scheduled job from a verified payment. A client
 * that could say "this household converted, pay me" would be an API for
 * printing rewards.
 *
 * NOTHING HERE READS ANOTHER FAMILY'S DATA. `summaryFor` returns the caller's
 * own code and three counts of the caller's own events, all filtered by the
 * tenant extension rather than by a `where` clause somebody had to remember.
 * The referred households appear nowhere in any response — a referrer learns
 * HOW MANY of their invitations converted, never WHO. That is a deliberate
 * product decision as much as a privacy one: a referral program that tells you
 * which of your friends is now paying for a parenting app is a program people
 * stop using.
 *
 * THROTTLED at 20/min on the write routes — the velocity limits in
 * `ReferralService` are the real defence, and this is the cheap outer layer
 * that stops them being reached by accident.
 */
@Controller('referral')
@ParentSurface()
@UseGuards(JwtAuthGuard)
export class ReferralController {
  constructor(private readonly referrals: ReferralService) {}

  /**
   * `IJwtPayload.familyId` is optional at the type level because a device token
   * carries none. Every route on this controller is `@ParentSurface()`, so it
   * is always present in practice — but the type is honest and this narrows it
   * once rather than asserting it three times.
   */
  private tenantOf(user: IJwtPayload): string {
    if (!user.familyId) {
      throw new ForbiddenException('This surface requires a parent session bound to a family.');
    }
    return user.familyId;
  }

  /** The caller's own code plus their own counts. Nothing cross-tenant. */
  @Get('me')
  async me(@CurrentUser() user: IJwtPayload) {
    return this.referrals.summaryFor(this.tenantOf(user), user.sub);
  }

  /** Idempotent: the same (code, channel) always returns the same URL. */
  @Post('link')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async link(@Body() dto: CreateLinkDto, @CurrentUser() user: IJwtPayload) {
    // The base URL is a deployment property, not something a client may choose
    // to arbitrary values — an attacker-supplied base would turn our referral
    // link into a phishing redirect carrying a legitimate code. A supplied
    // value is accepted only if it is one of the configured hosts; today that
    // is a single constant and the check is the `startsWith` below.
    const requested = dto.baseUrl ?? DEFAULT_REFERRAL_BASE_URL;
    const baseUrl = requested.startsWith(DEFAULT_REFERRAL_BASE_URL) ? requested : DEFAULT_REFERRAL_BASE_URL;

    const url = await this.referrals.ensureLink(this.tenantOf(user), user.sub, dto.channel, baseUrl);
    return { url, channel: dto.channel };
  }

  @Post('sent')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async sent(@Body() dto: RecordSentDto, @CurrentUser() user: IJwtPayload) {
    try {
      await this.referrals.recordSent(this.tenantOf(user), user.sub, dto.channel);
      return { ok: true };
    } catch (err) {
      if (err instanceof ReferralRateLimitError) {
        // The refusal has ALREADY been recorded as a REJECTED row by the
        // service. This is only how the parent is told, in a non-punitive
        // register (CONTEXT §3 principle 7).
        throw new ConflictException(
          'وصلت إلى حدّ الدعوات لهذا اليوم. جرّب غدًا — دعواتك السابقة ما زالت فعّالة.',
        );
      }
      throw err;
    }
  }
}

/**
 * The public link host. A constant rather than a `growth_settings` row on
 * purpose: it is a DEPLOYMENT fact (which domain this environment serves),
 * not a business decision, and putting it in a table an admin can edit would
 * make «change the referral domain» a runtime operation with no deploy behind
 * it — which is how a link host becomes an open redirect.
 */
const DEFAULT_REFERRAL_BASE_URL = 'https://abny.app';
