import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { PairingOrchestratorService } from '../../application/services/pairing-orchestrator.service';
import { InviteDto } from '../dto/invite.dto';
import { AcceptDto } from '../dto/accept.dto';
import { RegisterDeviceDto } from '../dto/register-device.dto';
import { VerifyDto } from '../dto/verify.dto';
import { ActivateDto } from '../dto/activate.dto';
import { RejectDto } from '../dto/reject.dto';
import { RevokeDto } from '../dto/revoke.dto';
import { RegistrationTokenGuard } from '../guards/registration-token.guard';
import { RegistrationContext } from '../decorators/registration-context.decorator';
import { ReportCapabilitiesDto } from '../dto/report-capabilities.dto';
import { HeartbeatDto } from '../dto/heartbeat.dto';
import { JwtAuthGuard, DeviceJwtAuthGuard } from '../../../auth/presentation/guards/jwt-auth.guard';
import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import type { IJwtPayload } from '../../../auth/domain/auth.types';
import type { IConsumedRegistrationToken } from '../../domain/registration-token.types';

@Controller('pairing')
export class PairingController {
  constructor(private readonly pairingOrchestrator: PairingOrchestratorService) {}

  @Post('invite')
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  invite(@Body() dto: InviteDto, @CurrentUser() user: IJwtPayload) {
    return this.pairingOrchestrator.invite(dto.childId, user.familyId!, user.sub);
  }

  @Post('accept')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  accept(@Body() dto: AcceptDto) {
    return this.pairingOrchestrator.accept(dto.code);
  }

  @Post('device/register')
  @UseGuards(RegistrationTokenGuard)
  @HttpCode(HttpStatus.CREATED)
  registerDevice(
    @Body() dto: RegisterDeviceDto,
    @RegistrationContext() context: IConsumedRegistrationToken,
  ) {
    return this.pairingOrchestrator.registerDevice(context.childId, context.familyId, dto);
  }

  @Post('verify')
  @UseGuards(DeviceJwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  verify(@Body() dto: VerifyDto, @CurrentUser() device: IJwtPayload) {
    return this.pairingOrchestrator.verify(device.sub, {
      attestationChain: dto.attestationChain,
      riskSignals: dto.riskSignals,
    });
  }

  @Post('activate')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  activate(@Body() dto: ActivateDto, @CurrentUser() user: IJwtPayload) {
    return this.pairingOrchestrator.activate(
      dto.deviceId,
      user.familyId!,
      user.sub,
      dto.overrideRiskWarning ?? false,
    );
  }

  @Post('reject')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async reject(@Body() dto: RejectDto, @CurrentUser() user: IJwtPayload): Promise<void> {
    await this.pairingOrchestrator.reject(dto.deviceId, user.familyId!, user.sub, dto.reason);
  }

  @Post('revoke')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async revoke(@Body() dto: RevokeDto, @CurrentUser() user: IJwtPayload): Promise<void> {
    await this.pairingOrchestrator.revoke(dto.deviceId, user.familyId!, user.sub, dto.reason);
  }

  @Get('device/:deviceId/status')
  @UseGuards(JwtAuthGuard)
  getStatus(@Param('deviceId') deviceId: string) {
    // NOTE: per pairing-backend-domain-architecture.md, this endpoint
    // should also accept DeviceJwtAuthGuard for device-self queries —
    // deferred to a follow-up (needs a combined-guard mechanism NestJS
    // doesn't provide for free); JwtAuthGuard-only (parent) covers
    // Sprint 3's actual consumer (Parent App/Dashboard status checks).
    return this.pairingOrchestrator.getStatus(deviceId);
  }

  @Post('device/heartbeat')
  @UseGuards(DeviceJwtAuthGuard)
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @HttpCode(HttpStatus.NO_CONTENT)
  async heartbeat(@Body() dto: HeartbeatDto, @CurrentUser() device: IJwtPayload): Promise<void> {
    await this.pairingOrchestrator.recordHeartbeat(device.sub, dto);
  }

  @Post('device/capabilities')
  @UseGuards(DeviceJwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async reportCapabilities(
    @Body() dto: ReportCapabilitiesDto,
    @CurrentUser() device: IJwtPayload,
  ): Promise<void> {
    await this.pairingOrchestrator.reportCapabilities(device.sub, dto);
  }

  @Get('device/policy')
  @UseGuards(DeviceJwtAuthGuard)
  getPolicySync(@CurrentUser() device: IJwtPayload) {
    return this.pairingOrchestrator.getPolicySync(device.sub);
  }

  @Get('devices')
  @UseGuards(JwtAuthGuard)
  listDevices(@CurrentUser() user: IJwtPayload) {
    return this.pairingOrchestrator.listFamilyDevices(user.familyId!);
  }
}
