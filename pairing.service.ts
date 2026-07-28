import { Inject, Injectable } from '@nestjs/common';

import type {
  IConfirmPairingInput,
  IDeviceSessionContext,
  IPairingTicket,
  ITokenPair,
} from '../../domain/auth.types';
import { InvalidOrExpiredPairingCodeException } from '../../domain/auth.errors';
import { RedisService } from '../../../../common/redis/redis.service';
import {
  DEVICE_REPOSITORY,
  type IDeviceRepository,
} from '../ports/auth.repository.ports';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

const PAIRING_CODE_TTL_SECONDS = 10 * 60; // 10 minutes
const PAIRING_REDIS_PREFIX = 'device-pairing:';

/**
 * Device pairing is intentionally two-step and out-of-band:
 *   1. Parent (already authenticated, already verified as belonging to the
 *      family that owns the child) calls `initiate` — this is the ONLY
 *      place a pairing code is ever created, and it requires proof the
 *      caller has authority over that child.
 *   2. The Child App calls `confirm` with the code the parent read aloud /
 *      typed in — the Child App itself never needs any prior credential.
 *
 * The code lives only in Redis (short TTL, one-time read via
 * getAndDelete) — it is never persisted to Postgres, so it cannot leak via
 * a database backup and cannot outlive its purpose.
 */
@Injectable()
export class PairingService {
  constructor(
    private readonly redisService: RedisService,
    private readonly passwordService: PasswordService,
    private readonly tokenService: TokenService,
    @Inject(DEVICE_REPOSITORY) private readonly deviceRepository: IDeviceRepository,
  ) {}

  async initiate(ticket: IPairingTicket): Promise<{ code: string; expiresInSeconds: number }> {
    const code = this.passwordService.generatePairingCode();
    await this.redisService.setWithTtl(
      this.redisKeyFor(code),
      JSON.stringify(ticket),
      PAIRING_CODE_TTL_SECONDS,
    );
    return { code, expiresInSeconds: PAIRING_CODE_TTL_SECONDS };
  }

  async confirm(
    input: IConfirmPairingInput,
    context: IDeviceSessionContext,
  ): Promise<{ tokens: ITokenPair; childId: string; familyId: string }> {
    const raw = await this.redisService.getAndDelete(this.redisKeyFor(input.code));
    if (!raw) {
      throw new InvalidOrExpiredPairingCodeException();
    }

    const ticket: IPairingTicket = JSON.parse(raw);

    const device = await this.deviceRepository.createPairedChildDevice({
      familyId: ticket.familyId,
      childId: ticket.childId,
      platform: input.platform,
      deviceModel: input.deviceModel,
      osVersion: input.osVersion,
      appVersion: input.appVersion,
      pushToken: input.pushToken,
    });

    const tokens = await this.tokenService.issueTokenPair({
      subjectId: device.id,
      actorType: 'DEVICE',
      familyId: ticket.familyId,
      userAgent: context.userAgent,
      ipAddress: context.ipAddress,
    });

    return { tokens, childId: ticket.childId, familyId: ticket.familyId };
  }

  private redisKeyFor(code: string): string {
    return `${PAIRING_REDIS_PREFIX}${code}`;
  }
}
