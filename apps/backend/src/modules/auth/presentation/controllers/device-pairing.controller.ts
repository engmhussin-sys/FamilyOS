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
