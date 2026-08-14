import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomUUID } from 'crypto';

import type { ActorType, IJwtPayload, ITokenPair } from '../../domain/auth.types';
import {
  InvalidOrExpiredTokenException,
  RefreshTokenReuseDetectedException,
} from '../../domain/auth.errors';
import { AuditService } from '../../../audit/application/audit.service';
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
  /** SA-002. Omitted on login/pairing (a brand new session starts its own
   * lineage); supplied on rotation so the successor stays in the same
   * family as the token it replaces. */
  familyTokenId?: string;
  /** SA-002. The id of the token being rotated out, so it can be linked
   * to its replacement. */
  replacesTokenId?: string;
}

/**
 * Owns the full lifecycle of JWT access/refresh tokens:
 *   - signing (with distinct secrets for access vs refresh, so a leaked
 *     access-token secret alone can't be used to forge long-lived refresh
 *     tokens),
 *   - verification,
 *   - refresh-token rotation WITH reuse detection (SA-002): every
 *     successful refresh revokes the old token and issues a brand new
 *     pair carrying the same `familyTokenId`. Presenting a token that
 *     was already rotated out revokes the entire family and writes an
 *     `auth.refresh_reuse_detected` audit event — see
 *     `verifyAndConsumeRefreshToken` below, which is where this actually
 *     happens (it is NOT delegated to the caller).
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
    private readonly auditService: AuditService,
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
      // A brand new session starts its own lineage, rooted at its own jti.
      familyTokenId: params.familyTokenId ?? jti,
    });

    if (params.replacesTokenId) {
      await this.refreshTokenRepository.markReplacedBy(params.replacesTokenId, jti);
    }

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
    const now = new Date();

    // SA-002: look the row up in ANY state first. Only this distinguishes
    // "token we never issued" (forged / from another environment) from
    // "token we issued and already rotated out" — the second is the
    // classic stolen-refresh-token signature and must not be answered
    // with a plain 401 and nothing else.
    const record = await this.refreshTokenRepository.findAnyByTokenHash(tokenHash);

    if (!record) {
      throw new InvalidOrExpiredTokenException(
        'Refresh token was already used, revoked, or does not exist.',
      );
    }

    if (record.revokedAt !== null) {
      await this.handleReuse(record, payload);
      throw new RefreshTokenReuseDetectedException();
    }

    if (record.expiresAt.getTime() <= now.getTime()) {
      throw new InvalidOrExpiredTokenException(
        'Refresh token was already used, revoked, or does not exist.',
      );
    }

    await this.refreshTokenRepository.revokeById(record.id, now);

    return { payload, record };
  }

  /**
   * SA-002. Two things happen, in this order, and neither is optional:
   *   1. the WHOLE rotation family is revoked — the attacker's freshly
   *      issued descendant included, which is the only action that
   *      actually ends the compromise. Revoking just the presented token
   *      would leave the thief's live chain untouched.
   *   2. a security event is written to the audit log so the compromise
   *      is visible after the fact rather than silently absorbed.
   *
   * The audit write is best-effort: a failing audit table must never
   * turn into "the family stayed alive", so revocation runs first and an
   * audit failure is swallowed deliberately (and only here).
   */
  private async handleReuse(
    record: { id: string; familyTokenId: string; userId: string | null; deviceId: string | null },
    payload: IJwtPayload,
  ): Promise<void> {
    const revokedCount = await this.refreshTokenRepository.revokeFamily(
      record.familyTokenId,
      new Date(),
    );

    try {
      await this.auditService.record({
        actorType: payload.actorType,
        actorUserId: payload.actorType === 'USER' ? payload.sub : undefined,
        action: 'auth.refresh_reuse_detected',
        entityType: payload.actorType === 'USER' ? 'User' : 'Device',
        entityId: payload.sub,
        metadata: {
          familyTokenId: record.familyTokenId,
          presentedTokenId: record.id,
          revokedTokenCount: revokedCount,
          userId: record.userId,
          deviceId: record.deviceId,
        },
      });
    } catch {
      // Deliberate: see the docstring above. Revocation already happened.
    }
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
