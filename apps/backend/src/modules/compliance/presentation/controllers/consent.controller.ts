import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { ConsentService } from '../../application/services/consent.service';
import { SetConsentDto } from '../dto/set-consent.dto';
import { JwtAuthGuard } from '../../../auth/presentation/guards/jwt-auth.guard';
import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import type { IJwtPayload } from '../../../auth/domain/auth.types';
import { ParentSurface } from '../../../../common/authz/roles.decorator';

@Controller('children/:childId/consents')
@UseGuards(JwtAuthGuard)
export class ConsentController {
  constructor(private readonly consentService: ConsentService) {}

  @Get()
  @ParentSurface()
  list(@Param('childId') childId: string, @CurrentUser() user: IJwtPayload) {
    return this.consentService.listConsents(childId, user.familyId!);
  }

  @Post()
  @ParentSurface()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  set(
    @Param('childId') childId: string,
    @Body() dto: SetConsentDto,
    @CurrentUser() user: IJwtPayload,
  ) {
    return this.consentService.setConsent(
      childId,
      user.familyId!,
      user.sub,
      dto.consentType,
      dto.granted,
    );
  }

  /** Sprint 1 (Consent Enforcement, Option C) — called once by the
   * Parent App right after creating a child, per that flow's own
   * registration-screen copy explaining what this means. Idempotent
   * (upsert-based) — calling it again is harmless. */
  @Post('grant-defaults')
  @ParentSurface()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  grantDefaults(@Param('childId') childId: string, @CurrentUser() user: IJwtPayload) {
    return this.consentService.grantDefaults(childId, user.familyId!, user.sub);
  }
}
