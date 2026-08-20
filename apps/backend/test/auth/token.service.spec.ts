import { Test } from '@nestjs/testing';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';

import { TokenService } from '../../src/modules/auth/application/services/token.service';
import { REFRESH_TOKEN_REPOSITORY } from '../../src/modules/auth/application/ports/auth.repository.ports';
import { AuditService } from '../../src/modules/audit/application/audit.service';
import {
  InvalidOrExpiredTokenException,
  RefreshTokenReuseDetectedException,
} from '../../src/modules/auth/domain/auth.errors';

const FUTURE = new Date(Date.now() + 60 * 60 * 1000);

describe('TokenService', () => {
  const refreshTokenRepositoryMock = {
    create: jest.fn(),
    findActiveByTokenHash: jest.fn(),
    findAnyByTokenHash: jest.fn(),
    revokeById: jest.fn(),
    revokeFamily: jest.fn(),
    markReplacedBy: jest.fn(),
    revokeAllForUser: jest.fn(),
  };

  const auditServiceMock = { record: jest.fn() };

  const configServiceMock = {
    getOrThrow: jest.fn((key: string) =>
      key === 'JWT_ACCESS_SECRET' ? 'access-secret-at-least-32-chars-long' : 'refresh-secret-at-least-32-chars-long',
    ),
  };

  let tokenService: TokenService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const moduleRef = await Test.createTestingModule({
      imports: [JwtModule.register({})],
      providers: [
        TokenService,
        { provide: ConfigService, useValue: configServiceMock },
        { provide: REFRESH_TOKEN_REPOSITORY, useValue: refreshTokenRepositoryMock },
        { provide: AuditService, useValue: auditServiceMock },
      ],
    }).compile();

    tokenService = moduleRef.get(TokenService);
  });

  it('issues an access/refresh pair and persists only a hash of the refresh token', async () => {
    refreshTokenRepositoryMock.create.mockResolvedValue({});

    const pair = await tokenService.issueTokenPair({
      subjectId: 'user-1',
      actorType: 'USER',
      familyId: 'family-1',
    });

    expect(pair.accessToken).toEqual(expect.any(String));
    expect(pair.refreshToken).toEqual(expect.any(String));
    expect(pair.accessToken).not.toBe(pair.refreshToken);

    const persistedInput = refreshTokenRepositoryMock.create.mock.calls[0][0];
    expect(persistedInput.tokenHash).not.toBe(pair.refreshToken); // never store raw token
    expect(persistedInput.userId).toBe('user-1');
  });

  it('verifies a correctly issued access token and rejects a refresh token in its place', async () => {
    refreshTokenRepositoryMock.create.mockResolvedValue({});
    const pair = await tokenService.issueTokenPair({ subjectId: 'user-1', actorType: 'USER' });

    const payload = await tokenService.verifyAccessToken(pair.accessToken);
    expect(payload.sub).toBe('user-1');
    expect(payload.tokenKind).toBe('access');

    await expect(tokenService.verifyAccessToken(pair.refreshToken)).rejects.toBeInstanceOf(
      InvalidOrExpiredTokenException,
    );
  });

  it('rejects verifyAndConsumeRefreshToken when no DB record matches at all (forged / foreign token)', async () => {
    refreshTokenRepositoryMock.create.mockResolvedValue({});
    const pair = await tokenService.issueTokenPair({ subjectId: 'user-1', actorType: 'USER' });

    refreshTokenRepositoryMock.findAnyByTokenHash.mockResolvedValue(null);

    await expect(tokenService.verifyAndConsumeRefreshToken(pair.refreshToken)).rejects.toBeInstanceOf(
      InvalidOrExpiredTokenException,
    );
    // No family to revoke, nothing to report — this is not a reuse event.
    expect(refreshTokenRepositoryMock.revokeFamily).not.toHaveBeenCalled();
    expect(auditServiceMock.record).not.toHaveBeenCalled();
  });

  it('revokes the refresh token record on successful consumption (rotation)', async () => {
    refreshTokenRepositoryMock.create.mockResolvedValue({});
    const pair = await tokenService.issueTokenPair({ subjectId: 'user-1', actorType: 'USER' });

    refreshTokenRepositoryMock.findAnyByTokenHash.mockResolvedValue({
      id: 'token-row-1',
      familyTokenId: 'family-token-1',
      userId: 'user-1',
      deviceId: null,
      revokedAt: null,
      expiresAt: FUTURE,
    });

    const { payload, record } = await tokenService.verifyAndConsumeRefreshToken(pair.refreshToken);

    expect(payload.sub).toBe('user-1');
    expect(record.familyTokenId).toBe('family-token-1');
    expect(refreshTokenRepositoryMock.revokeById).toHaveBeenCalledWith(
      'token-row-1',
      expect.any(Date),
    );
    expect(refreshTokenRepositoryMock.revokeFamily).not.toHaveBeenCalled();
    expect(auditServiceMock.record).not.toHaveBeenCalled();
  });

  // ---- SA-002: refresh token reuse detection ----

  it('roots a brand new session in its own token family', async () => {
    refreshTokenRepositoryMock.create.mockResolvedValue({});

    await tokenService.issueTokenPair({ subjectId: 'user-1', actorType: 'USER' });

    const persisted = refreshTokenRepositoryMock.create.mock.calls[0][0];
    expect(persisted.familyTokenId).toBe(persisted.jti);
    expect(refreshTokenRepositoryMock.markReplacedBy).not.toHaveBeenCalled();
  });

  it('keeps a rotated successor in the same family and links it to its predecessor', async () => {
    refreshTokenRepositoryMock.create.mockResolvedValue({});

    await tokenService.issueTokenPair({
      subjectId: 'user-1',
      actorType: 'USER',
      familyTokenId: 'family-token-1',
      replacesTokenId: 'token-row-1',
    });

    const persisted = refreshTokenRepositoryMock.create.mock.calls[0][0];
    expect(persisted.familyTokenId).toBe('family-token-1');
    expect(persisted.jti).not.toBe('family-token-1');
    expect(refreshTokenRepositoryMock.markReplacedBy).toHaveBeenCalledWith(
      'token-row-1',
      persisted.jti,
    );
  });

  it('detects reuse of an already-rotated token, revokes the WHOLE family, and audits it', async () => {
    refreshTokenRepositoryMock.create.mockResolvedValue({});
    const pair = await tokenService.issueTokenPair({ subjectId: 'user-1', actorType: 'USER' });

    // The row exists but was already rotated out — the stolen-token signature.
    refreshTokenRepositoryMock.findAnyByTokenHash.mockResolvedValue({
      id: 'token-row-1',
      familyTokenId: 'family-token-1',
      userId: 'user-1',
      deviceId: null,
      revokedAt: new Date(),
      expiresAt: FUTURE,
    });
    refreshTokenRepositoryMock.revokeFamily.mockResolvedValue(3);

    await expect(
      tokenService.verifyAndConsumeRefreshToken(pair.refreshToken),
    ).rejects.toBeInstanceOf(RefreshTokenReuseDetectedException);

    expect(refreshTokenRepositoryMock.revokeFamily).toHaveBeenCalledWith(
      'family-token-1',
      expect.any(Date),
    );
    expect(auditServiceMock.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.refresh_reuse_detected',
        actorType: 'USER',
        actorUserId: 'user-1',
        entityType: 'User',
        entityId: 'user-1',
        metadata: expect.objectContaining({
          familyTokenId: 'family-token-1',
          presentedTokenId: 'token-row-1',
          revokedTokenCount: 3,
        }),
      }),
    );
    // The reuse response must be indistinguishable from a plain failure.
    expect(new RefreshTokenReuseDetectedException()).toBeInstanceOf(InvalidOrExpiredTokenException);
  });

  it('detects reuse for a DEVICE token family too', async () => {
    refreshTokenRepositoryMock.create.mockResolvedValue({});
    const pair = await tokenService.issueTokenPair({ subjectId: 'device-1', actorType: 'DEVICE' });

    refreshTokenRepositoryMock.findAnyByTokenHash.mockResolvedValue({
      id: 'token-row-9',
      familyTokenId: 'family-token-9',
      userId: null,
      deviceId: 'device-1',
      revokedAt: new Date(),
      expiresAt: FUTURE,
    });
    refreshTokenRepositoryMock.revokeFamily.mockResolvedValue(2);

    await expect(
      tokenService.verifyAndConsumeRefreshToken(pair.refreshToken),
    ).rejects.toBeInstanceOf(RefreshTokenReuseDetectedException);

    expect(refreshTokenRepositoryMock.revokeFamily).toHaveBeenCalledWith(
      'family-token-9',
      expect.any(Date),
    );
    expect(auditServiceMock.record).toHaveBeenCalledWith(
      expect.objectContaining({ actorType: 'DEVICE', entityType: 'Device', entityId: 'device-1' }),
    );
  });

  it('still revokes the family when the audit write itself fails', async () => {
    refreshTokenRepositoryMock.create.mockResolvedValue({});
    const pair = await tokenService.issueTokenPair({ subjectId: 'user-1', actorType: 'USER' });

    refreshTokenRepositoryMock.findAnyByTokenHash.mockResolvedValue({
      id: 'token-row-1',
      familyTokenId: 'family-token-1',
      userId: 'user-1',
      deviceId: null,
      revokedAt: new Date(),
      expiresAt: FUTURE,
    });
    refreshTokenRepositoryMock.revokeFamily.mockResolvedValue(1);
    auditServiceMock.record.mockRejectedValueOnce(new Error('audit table unavailable'));

    await expect(
      tokenService.verifyAndConsumeRefreshToken(pair.refreshToken),
    ).rejects.toBeInstanceOf(RefreshTokenReuseDetectedException);

    expect(refreshTokenRepositoryMock.revokeFamily).toHaveBeenCalled();
  });

  it('rejects an expired-but-never-revoked token without treating it as reuse', async () => {
    refreshTokenRepositoryMock.create.mockResolvedValue({});
    const pair = await tokenService.issueTokenPair({ subjectId: 'user-1', actorType: 'USER' });

    refreshTokenRepositoryMock.findAnyByTokenHash.mockResolvedValue({
      id: 'token-row-1',
      familyTokenId: 'family-token-1',
      userId: 'user-1',
      deviceId: null,
      revokedAt: null,
      expiresAt: new Date(Date.now() - 1000),
    });

    await expect(
      tokenService.verifyAndConsumeRefreshToken(pair.refreshToken),
    ).rejects.toBeInstanceOf(InvalidOrExpiredTokenException);
    expect(refreshTokenRepositoryMock.revokeFamily).not.toHaveBeenCalled();
  });
});
