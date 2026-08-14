import { Body, Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { SupportService } from '../../application/services/support.service';
import { CreateSupportRequestDto } from '../../application/dto/create-support-request.dto';
import { InternalAdminGuard } from '../../../../common/guards/internal-admin.guard';
import { OptionalJwtAuthGuard } from '../../../auth/presentation/guards/jwt-auth.guard';
import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import type { IJwtPayload } from '../../../auth/domain/auth.types';
import { SystemRoute } from '../../../../common/tenancy/system-route.decorator';

@Controller('support')
export class SupportController {
  constructor(private readonly supportService: SupportService) {}

  /** No auth guard — deliberately public, same reasoning as the DTO's
   * own docstring. Rate-limited at 5/min per IP (Nest's default
   * Throttler tracking), matching the same tightness already used
   * for auth/register and billing/subscribe — public + unauthenticated
   * endpoints are the ones most worth protecting from scripted abuse. */
  @Post()
  @SystemRoute(
    'ACCOUNT_LIFECYCLE',
    'A support request may legitimately arrive from someone who is not logged in; SupportRequest.familyId is nullable for exactly that case.',
  )
  @UseGuards(OptionalJwtAuthGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(HttpStatus.CREATED)
  submit(@Body() dto: CreateSupportRequestDto, @CurrentUser() user?: IJwtPayload) {
    // `user` is populated only when a real, signature-verified token was
    // presented. Anonymous submissions land here with `undefined` and are
    // stored unattributed — never with a family the body claimed.
    return this.supportService.submit(dto, { familyId: user?.familyId, userId: user?.sub });
  }

  /** CLOSES A CRITICAL GAP (proactive business audit): the module
   * could receive requests but the team had no way to ever read them
   * back — see SupportService.listAll's own docstring. */
  @Get()
  @SystemRoute('ADMIN_CONSOLE', 'Internal support queue, behind InternalAdminGuard; reading it is cross-tenant by purpose.')
  @UseGuards(InternalAdminGuard)
  listAll() {
    return this.supportService.listAll();
  }
}
