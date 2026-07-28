import { Module } from '@nestjs/common';

import { PairingStateMachineService } from './application/services/pairing-state-machine.service';
import { PrismaPairingEventRepository } from './infrastructure/repositories/prisma-pairing-event.repository';
import { PAIRING_EVENT_REPOSITORY } from './application/ports/pairing-event.repository.port';

/**
 * No controllers yet (Step 2.2.3). No Auth module import needed yet —
 * this step's service has no dependency on TokenService (that arrives
 * with the Registration Token Service, Step 2.2.2's Service 3).
 * Exported so AppModule can register it and so later services in this
 * same module (Invitation, Registration Token, Trust/Risk Evaluation)
 * can be added to `providers` here as they're built, one at a time, per
 * this step's "implement services one by one" instruction.
 */
@Module({
  providers: [
    PairingStateMachineService,
    { provide: PAIRING_EVENT_REPOSITORY, useClass: PrismaPairingEventRepository },
  ],
  exports: [PairingStateMachineService],
})
export class PairingModule {}
