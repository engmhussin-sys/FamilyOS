import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomUUID } from 'crypto';

import type { ActorType, IJwtPayload, ITokenPair } from '../../domain/auth.types';
import { InvalidOrExpiredTokenException } from '../../domain/auth.errors';
import {
  REFRESH_TOKEN_REPOSITORY,
  type IRefreshTokenRepository,
} from '../ports/auth.repository.ports';

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60; // 15 minutes
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

interface IIssueTokenPairParams {
  subjectId: string; // userId or deviceId, depending on actorType
  actorType: ActorType;
  familyId?: string;
  userAgent?: string;
  ipAddress?: string;
}

/**
 * Owns the full lifecycle of JWT access/refresh tokens:
 *   - signing (with distinct secrets for access vs refresh, so a leaked
 *     access-token secret alone can't be used to forge long-lived refresh
 *     tokens),
 *   - verification,
 *   - refresh-token rotation (every successful refresh revokes the old
 *     token and issues a brand new pair — reuse of a revoked token is
 *     treated as a security event by the caller, see AuthService.refresh).
 *
 * Refresh tokens are never stored in the database in plaintext — only a
 * SHA-256 hash of the signed JWT string — so a database read alone can
 * never yield a usable token.
 */
@Injectable()
export class TokenService {
  private readonly accessSecret: string;
  private readonly refreshSecret: string;

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    @Inject(REFRESH_TOKEN_REPOSITORY)
    private readonly refreshTokenRepository: IRefreshTokenRepository,
  ) {
    this.accessSecret = this.configService.getOrThrow<string>('JWT_ACCESS_SECRET');
    this.refreshSecret = this.configService.getOrThrow<string>('JWT_REFRESH_SECRET');
  }

  async issueTokenPair(params: IIssueTokenPairParams): Promise<ITokenPair> {
    const jti = randomUUID();

    const accessPayload: IJwtPayload = {
      sub: params.subjectId,
      actorType: params.actorType,
      tokenKind: 'access',
      familyId: params.familyId,
      jti,
    };
    const refreshPayload: IJwtPayload = { ...accessPayload, tokenKind: 'refresh' };

    const accessToken = await this.jwtService.signAsync(accessPayload, {
      secret: this.accessSecret,
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    });
    const refreshToken = await this.jwtService.signAsync(refreshPayload, {
      secret: this.refreshSecret,
      expiresIn: REFRESH_TOKEN_TTL_SECONDS,
    });

    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000);

    await this.refreshTokenRepository.create({
      jti,
      tokenHash: this.hashToken(refreshToken),
      userId: params.actorType === 'USER' ? params.subjectId : undefined,
      deviceId: params.actorType === 'DEVICE' ? params.subjectId : undefined,
      expiresAt,
      userAgent: params.userAgent,
      ipAddress: params.ipAddress,
    });

    return {
      accessToken,
      refreshToken,
      accessTokenExpiresInSeconds: ACCESS_TOKEN_TTL_SECONDS,
      refreshTokenExpiresInSeconds: REFRESH_TOKEN_TTL_SECONDS,
    };
  }

  async verifyAccessToken(token: string): Promise<IJwtPayload> {
    return this.verify(token, this.accessSecret, 'access');
  }

  /**
   * Verifies signature/expiry AND checks the DB record is still active
   * (not revoked). This is what makes server-side revocation possible —
   * a stateless-only JWT check would let a revoked refresh token keep
   * working until it naturally expires.
   */
  async verifyAndConsumeRefreshToken(token: string) {
    const payload = await this.verify(token, this.refreshSecret, 'refresh');
    const tokenHash = this.hashToken(token);
    const record = await this.refreshTokenRepository.findActiveByTokenHash(tokenHash);

    if (!record) {
      throw new InvalidOrExpiredTokenException(
        'Refresh token was already used, revoked, or does not exist.',
      );
    }

    await this.refreshTokenRepository.revokeById(record.id, new Date());

    return { payload, record };
  }

  private async verify(
    token: string,
    secret: string,
    expectedKind: IJwtPayload['tokenKind'],
  ): Promise<IJwtPayload> {
    try {
      const payload = await this.jwtService.verifyAsync<IJwtPayload>(token, { secret });
      if (payload.tokenKind !== expectedKind) {
        throw new InvalidOrExpiredTokenException(`Expected a ${expectedKind} token.`);
      }
      return payload;
    } catch (err) {
      if (err instanceof InvalidOrExpiredTokenException) throw err;
      throw new InvalidOrExpiredTokenException();
    }
  }

  /**
   * Sprint 3 addition — the one new public surface TokenService exposes
   * specifically for PairingModule's /pairing/revoke. Kept as a named
   * method (not exposing the repository itself) so Pairing depends on
   * TokenService's stable public contract, same as it already does for
   * issueTokenPair — not on Auth's internal repository shape.
   */
  async revokeAllTokensForDevice(deviceId: string): Promise<void> {
    await this.refreshTokenRepository.revokeAllForDevice(deviceId, new Date());
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
