import { Injectable } from '@nestjs/common';

import { RedisService } from '../../../../common/redis/redis.service';
import { generatePairingCode } from '../../../../common/utils/generate-pairing-code.util';
import { ChildrenService } from '../../../children/application/services/children.service';
import { PairingStateMachineService } from './pairing-state-machine.service';
import type {
  ICreateInvitationInput,
  IInvitationTicket,
  IRedeemedInvitation,
} from '../../domain/invitation.types';
import { InvalidOrExpiredInvitationException } from '../../domain/invitation.errors';

const INVITATION_TTL_SECONDS = 10 * 60; // unchanged from the original PairingService design
const REDIS_PREFIX = 'pairing-invitation:';

/**
 * Owns the Redis-backed PairingInvitation lifecycle (§1 of
 * pairing-step-2-2-1-database-entities.md — deliberately NOT a Postgres
 * table). Every successful call also drives the state machine
 * (PairingStateMachineService), so the append-only audit trail and the
 * ephemeral Redis ticket stay in lockstep — this service is the one
 * place both are touched together, not two independently-updated systems.
 */
@Injectable()
export class InvitationService {
  constructor(
    private readonly redisService: RedisService,
    private readonly childrenService: ChildrenService,
    private readonly pairingStateMachine: PairingStateMachineService,
  ) {}

  async createInvitation(input: ICreateInvitationInput): Promise<IInvitationTicket> {
    // Family ownership check — same established pattern as every other
    // module that accepts a childId (children-module.md §2).
    await this.childrenService.assertChildBelongsToFamily(input.childId, input.familyId);

    const code = generatePairingCode();
    await this.redisService.setWithTtl(
      this.redisKeyFor(code),
      JSON.stringify({
        childId: input.childId,
        familyId: input.familyId,
        initiatedByUserId: input.initiatedByUserId,
      }),
      INVITATION_TTL_SECONDS,
    );

    await this.pairingStateMachine.transition({
      childId: input.childId,
      event: 'PAIRING_INVITED',
      actorType: 'USER',
      actorId: input.initiatedByUserId,
    });

    return { code, expiresInSeconds: INVITATION_TTL_SECONDS };
  }

  async redeemInvitation(code: string): Promise<IRedeemedInvitation> {
    const raw = await this.redisService.getAndDelete(this.redisKeyFor(code));
    if (!raw) {
      throw new InvalidOrExpiredInvitationException();
    }

    const ticket = JSON.parse(raw) as IRedeemedInvitation;

    await this.pairingStateMachine.transition({
      childId: ticket.childId,
      event: 'PAIRING_ACCEPTED',
      actorType: 'DEVICE',
    });

    return ticket;
  }

  private redisKeyFor(code: string): string {
    return `${REDIS_PREFIX}${code}`;
  }
}
