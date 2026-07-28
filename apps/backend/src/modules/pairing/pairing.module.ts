import { Module } from '@nestjs/common';

import { ChildrenModule } from '../children/children.module';
import { AuthModule } from '../auth/auth.module';
import { ScreenTimeModule } from '../screen-time/screen-time.module';
import { PairingController } from './presentation/controllers/pairing.controller';
import { RegistrationTokenGuard } from './presentation/guards/registration-token.guard';
import { PairingStateMachineService } from './application/services/pairing-state-machine.service';
import { InvitationService } from './application/services/invitation.service';
import { RegistrationTokenService } from './application/services/registration-token.service';
import { TrustEvaluationService } from './application/services/trust-evaluation.service';
import { RiskEvaluationService } from './application/services/risk-evaluation.service';
import { PairingOrchestratorService } from './application/services/pairing-orchestrator.service';
import { PrismaPairingEventRepository } from './infrastructure/repositories/prisma-pairing-event.repository';
import { PrismaDeviceTrustRepository } from './infrastructure/repositories/prisma-device-trust.repository';
import { PrismaDeviceRiskRepository } from './infrastructure/repositories/prisma-device-risk.repository';
import { PrismaPairingDeviceRepository } from './infrastructure/repositories/prisma-pairing-device.repository';
import { PAIRING_EVENT_REPOSITORY } from './application/ports/pairing-event.repository.port';
import { DEVICE_TRUST_REPOSITORY, TRUST_SIGNAL_PROVIDER } from './application/ports/device-trust.repository.port';
import { DEVICE_RISK_REPOSITORY, RISK_SIGNAL_PROVIDER } from './application/ports/device-risk.repository.port';
import { PAIRING_DEVICE_REPOSITORY } from './application/ports/pairing-device.repository.port';

/**
 * Sprint 3: PairingController is now live (Step 2.2.3, previously
 * deferred). Imports AuthModule for TokenService (pairing-module-boundary.md
 * §2's one agreed integration point — Auth is never imported the other
 * way around) and to make RegistrationTokenGuard/JwtAuthGuard/
 * DeviceJwtAuthGuard available where the controller references them.
 */
@Module({
  imports: [ChildrenModule, AuthModule, ScreenTimeModule],
  controllers: [PairingController],
  providers: [
    PairingStateMachineService,
    InvitationService,
    RegistrationTokenService,
    TrustEvaluationService,
    RiskEvaluationService,
    PairingOrchestratorService,
    RegistrationTokenGuard,
    { provide: PAIRING_EVENT_REPOSITORY, useClass: PrismaPairingEventRepository },
    { provide: DEVICE_TRUST_REPOSITORY, useClass: PrismaDeviceTrustRepository },
    { provide: DEVICE_RISK_REPOSITORY, useClass: PrismaDeviceRiskRepository },
    { provide: PAIRING_DEVICE_REPOSITORY, useClass: PrismaPairingDeviceRepository },
    { provide: TRUST_SIGNAL_PROVIDER, useExisting: TrustEvaluationService },
    { provide: RISK_SIGNAL_PROVIDER, useExisting: RiskEvaluationService },
  ],
  exports: [
    PairingStateMachineService,
    InvitationService,
    RegistrationTokenService,
    TrustEvaluationService,
    RiskEvaluationService,
    PairingOrchestratorService,
    TRUST_SIGNAL_PROVIDER,
    RISK_SIGNAL_PROVIDER,
  ],
})
export class PairingModule {}
