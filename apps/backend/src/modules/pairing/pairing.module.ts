import { Module } from '@nestjs/common';

import { ChildrenModule } from '../children/children.module';
import { PairingStateMachineService } from './application/services/pairing-state-machine.service';
import { InvitationService } from './application/services/invitation.service';
import { RegistrationTokenService } from './application/services/registration-token.service';
import { TrustEvaluationService } from './application/services/trust-evaluation.service';
import { RiskEvaluationService } from './application/services/risk-evaluation.service';
import { PrismaPairingEventRepository } from './infrastructure/repositories/prisma-pairing-event.repository';
import { PrismaDeviceTrustRepository } from './infrastructure/repositories/prisma-device-trust.repository';
import { PrismaDeviceRiskRepository } from './infrastructure/repositories/prisma-device-risk.repository';
import { PAIRING_EVENT_REPOSITORY } from './application/ports/pairing-event.repository.port';
import { DEVICE_TRUST_REPOSITORY, TRUST_SIGNAL_PROVIDER } from './application/ports/device-trust.repository.port';
import { DEVICE_RISK_REPOSITORY, RISK_SIGNAL_PROVIDER } from './application/ports/device-risk.repository.port';

/**
 * No controllers yet (Step 2.2.3). RedisService/PrismaService are
 * injected directly without an explicit import since RedisModule and
 * PrismaModule are both @Global() (same pattern AuthModule already uses).
 * ChildrenModule imported for InvitationService's family-ownership check.
 *
 * TRUST_SIGNAL_PROVIDER / RISK_SIGNAL_PROVIDER (Sprint 2): bound via
 * `useExisting`, not a separate instance — a future AI Core Engine
 * consumer injects the interface token, never TrustEvaluationService/
 * RiskEvaluationService directly. This is the dependency-inversion
 * boundary Decision-068 asked for, applied at the module-export level.
 */
@Module({
  imports: [ChildrenModule],
  providers: [
    PairingStateMachineService,
    InvitationService,
    RegistrationTokenService,
    TrustEvaluationService,
    RiskEvaluationService,
    { provide: PAIRING_EVENT_REPOSITORY, useClass: PrismaPairingEventRepository },
    { provide: DEVICE_TRUST_REPOSITORY, useClass: PrismaDeviceTrustRepository },
    { provide: DEVICE_RISK_REPOSITORY, useClass: PrismaDeviceRiskRepository },
    { provide: TRUST_SIGNAL_PROVIDER, useExisting: TrustEvaluationService },
    { provide: RISK_SIGNAL_PROVIDER, useExisting: RiskEvaluationService },
  ],
  exports: [
    PairingStateMachineService,
    InvitationService,
    RegistrationTokenService,
    TrustEvaluationService,
    RiskEvaluationService,
    TRUST_SIGNAL_PROVIDER,
    RISK_SIGNAL_PROVIDER,
  ],
})
export class PairingModule {}
