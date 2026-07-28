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
 * NOTE: `initiate` currently trusts `payload.familyId` from the parent's
 * access token as the scope for the pairing. It does NOT yet verify that
 * `childId` belongs to that family — that check belongs to a ChildrenModule
 * (family-scoped Child lookups) which is the next module to build. Until
 * then, `PairingService.initiate` is only safe to call with a childId the
 * caller is trusted to have obtained from a family-scoped "list my
 * children" endpoint. Tracked as a follow-up, not silently skipped.
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
