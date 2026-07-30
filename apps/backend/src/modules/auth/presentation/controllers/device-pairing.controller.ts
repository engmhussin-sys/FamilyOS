import { Body, Controller, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';

import { PairingService } from '../../application/services/pairing.service';
import { InitiatePairingDto } from '../dto/initiate-pairing.dto';
import { ConfirmPairingDto } from '../dto/confirm-pairing.dto';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import type { IJwtPayload } from '../../domain/auth.types';

/**
 * @deprecated Sprint 9 (Final Architecture Review) finding: this
 * controller predates the full PairingModule (Sprint 2 onward) and was
 * documented as "Deprecated, not removed" in
 * docs/architecture/pairing-module-boundary.md \u00a75 \u2014 but had NO
 * deprecation marker anywhere in the actual code until this fix, and
 * the Admin Dashboard was still calling it (also fixed this session \u2014
 * see admin-dashboard's pairingApi.ts). Kept for backward compatibility
 * with any external caller that may still target this path; all new
 * code must use `POST /pairing/invite` (PairingController).
 *
 * `initiate` trusts `payload.familyId` from the parent's access token as
 * the scope for the pairing, and `PairingService.initiate` now verifies
 * (via `ChildrenService.assertChildBelongsToFamily`) that `childId`
 * actually belongs to that family before a pairing code is ever
 * generated — see docs/architecture/children-module.md §3.
 */
@Controller('auth/devices/pairing')
export class DevicePairingController {
  constructor(private readonly pairingService: PairingService) {}

  @Post('initiate')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async initiate(@Body() dto: InitiatePairingDto, @CurrentUser() user: IJwtPayload) {
    return this.pairingService.initiate({
      familyId: user.familyId!,
      childId: dto.childId,
      initiatedByUserId: user.sub,
    });
  }

  @Post('confirm')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  async confirm(@Body() dto: ConfirmPairingDto, @Req() req: Request) {
    return this.pairingService.confirm(dto, {
      userAgent: req.headers['user-agent'],
      ipAddress: req.ip,
    });
  }
}
