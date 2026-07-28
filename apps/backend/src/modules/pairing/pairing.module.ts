import { Module } from '@nestjs/common';

import { ChildrenModule } from '../children/children.module';
import { PairingStateMachineService } from './application/services/pairing-state-machine.service';
import { InvitationService } from './application/services/invitation.service';
import { RegistrationTokenService } from './application/services/registration-token.service';
import { PrismaPairingEventRepository } from './infrastructure/repositories/prisma-pairing-event.repository';
import { PAIRING_EVENT_REPOSITORY } from './application/ports/pairing-event.repository.port';

/**
 * No controllers yet (Step 2.2.3). RedisService/PrismaService are
 * injected directly without an explicit import since RedisModule and
 * PrismaModule are both @Global() (same pattern AuthModule already uses).
 * ChildrenModule imported for InvitationService's family-ownership check
 * — the one established cross-module dependency every module in this
 * project uses the same way.
 */
@Module({
  imports: [ChildrenModule],
  providers: [
    PairingStateMachineService,
    InvitationService,
    RegistrationTokenService,
    { provide: PAIRING_EVENT_REPOSITORY, useClass: PrismaPairingEventRepository },
  ],
  exports: [PairingStateMachineService, InvitationService, RegistrationTokenService],
})
export class PairingModule {}
