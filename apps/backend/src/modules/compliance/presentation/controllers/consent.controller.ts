import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';

import { ConsentService } from '../../application/services/consent.service';
import { SetConsentDto } from '../dto/set-consent.dto';
import { JwtAuthGuard } from '../../../auth/presentation/guards/jwt-auth.guard';
import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import type { IJwtPayload } from '../../../auth/domain/auth.types';

@Controller('children/:childId/consents')
@UseGuards(JwtAuthGuard)
export class ConsentController {
  constructor(private readonly consentService: ConsentService) {}

  @Get()
  list(@Param('childId') childId: string, @CurrentUser() user: IJwtPayload) {
    return this.consentService.listConsents(childId, user.familyId!);
  }

  @Post()
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
}
