import { Test } from '@nestjs/testing';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';

import { TokenService } from '../../src/modules/auth/application/services/token.service';
import { REFRESH_TOKEN_REPOSITORY } from '../../src/modules/auth/application/ports/auth.repository.ports';
import { InvalidOrExpiredTokenException } from '../../src/modules/auth/domain/auth.errors';

describe('TokenService', () => {
  const refreshTokenRepositoryMock = {
    create: jest.fn(),
    findActiveByTokenHash: jest.fn(),
    revokeById: jest.fn(),
    revokeAllForUser: jest.fn(),
  };

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

  it('rejects verifyAndConsumeRefreshToken when no active DB record matches (already revoked/used)', async () => {
    refreshTokenRepositoryMock.create.mockResolvedValue({});
    const pair = await tokenService.issueTokenPair({ subjectId: 'user-1', actorType: 'USER' });

    refreshTokenRepositoryMock.findActiveByTokenHash.mockResolvedValue(null);

    await expect(tokenService.verifyAndConsumeRefreshToken(pair.refreshToken)).rejects.toBeInstanceOf(
      InvalidOrExpiredTokenException,
    );
  });

  it('revokes the refresh token record on successful consumption (rotation)', async () => {
    refreshTokenRepositoryMock.create.mockResolvedValue({});
    const pair = await tokenService.issueTokenPair({ subjectId: 'user-1', actorType: 'USER' });

    refreshTokenRepositoryMock.findActiveByTokenHash.mockResolvedValue({ id: 'token-row-1' });

    const { payload } = await tokenService.verifyAndConsumeRefreshToken(pair.refreshToken);

    expect(payload.sub).toBe('user-1');
    expect(refreshTokenRepositoryMock.revokeById).toHaveBeenCalledWith(
      'token-row-1',
      expect.any(Date),
    );
  });
});
