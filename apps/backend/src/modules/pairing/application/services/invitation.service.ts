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
import { runWithTenant } from '../../../../common/tenancy/tenant-context';

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

    // The device that redeemed this code holds no token yet, so the request
    // arrived under a SystemContext (@SystemRoute AUTH_BOOTSTRAP). The tenant
    // is now known — and it was derived SERVER-side: it was written into Redis
    // by createInvitation from the inviting parent's own token, never sent by
    // the device. Establishing it here is what lets the state-machine write
    // (a tenant-scoped DevicePairingEvent) succeed under the extension without
    // widening the bypass to the whole request.
    await runWithTenant(
      { familyId: ticket.familyId, actorType: 'DEVICE', actorId: `pairing-accept:${ticket.childId}` },
      () =>
        this.pairingStateMachine.transition({
          childId: ticket.childId,
          event: 'PAIRING_ACCEPTED',
          actorType: 'DEVICE',
        }),
    );

    return ticket;
  }

  private redisKeyFor(code: string): string {
    return `${REDIS_PREFIX}${code}`;
  }
}
