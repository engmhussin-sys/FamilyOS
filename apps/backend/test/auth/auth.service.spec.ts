import { Test } from '@nestjs/testing';
import { AuthService } from '../../src/modules/auth/application/services/auth.service';
import { PasswordService } from '../../src/modules/auth/application/services/password.service';
import { TokenService } from '../../src/modules/auth/application/services/token.service';
import { USER_REPOSITORY } from '../../src/modules/auth/application/ports/auth.repository.ports';
import { AuditService } from '../../src/modules/audit/application/audit.service';
import {
  EmailAlreadyRegisteredException,
  InvalidCredentialsException,
} from '../../src/modules/auth/domain/auth.errors';

describe('AuthService', () => {
  const userRepositoryMock = {
    findByEmail: jest.fn(),
    findById: jest.fn(),
    createParentWithFamily: jest.fn(),
    updateLastLoginAt: jest.fn(),
    findPrimaryFamilyMembership: jest.fn(),
  };

  const passwordServiceMock = {
    hash: jest.fn(),
    verify: jest.fn(),
  };

  const tokenServiceMock = {
    issueTokenPair: jest.fn(),
    verifyAndConsumeRefreshToken: jest.fn(),
  };

  const auditServiceMock = { record: jest.fn() };

  let authService: AuthService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: USER_REPOSITORY, useValue: userRepositoryMock },
        { provide: PasswordService, useValue: passwordServiceMock },
        { provide: TokenService, useValue: tokenServiceMock },
        { provide: AuditService, useValue: auditServiceMock },
      ],
    }).compile();

    authService = moduleRef.get(AuthService);
  });

  describe('register', () => {
    it('rejects registration when the email is already taken', async () => {
      userRepositoryMock.findByEmail.mockResolvedValue({ id: 'existing-user' });

      await expect(
        authService.register({
          email: 'taken@example.com',
          password: 'Sup3rSecret!',
          fullName: 'Existing Parent',
          acceptedTerms: true,
        }),
      ).rejects.toBeInstanceOf(EmailAlreadyRegisteredException);

      expect(userRepositoryMock.createParentWithFamily).not.toHaveBeenCalled();
    });

    it('hashes the password and creates a User + Family atomically', async () => {
      userRepositoryMock.findByEmail.mockResolvedValue(null);
      passwordServiceMock.hash.mockResolvedValue('hashed-password');
      userRepositoryMock.createParentWithFamily.mockResolvedValue({
        user: { id: 'user-1', email: 'new@example.com', fullName: 'New Parent' },
        family: { id: 'family-1' },
        membership: { role: 'OWNER' },
      });

      const result = await authService.register({
        email: 'New@Example.com',
        password: 'Sup3rSecret!',
        fullName: 'New Parent',
        acceptedTerms: true,
      });

      expect(passwordServiceMock.hash).toHaveBeenCalledWith('Sup3rSecret!');
      // Email is normalized to lowercase before lookups and persistence.
      expect(userRepositoryMock.findByEmail).toHaveBeenCalledWith('new@example.com');
      // CLOSES A REAL GAP (proactive business/code audit): acceptedTerms
      // must actually reach the repository, not just be validated at
      // the DTO boundary and then silently dropped.
      expect(userRepositoryMock.createParentWithFamily).toHaveBeenCalledWith(
        expect.objectContaining({ acceptedTerms: true }),
        'hashed-password',
      );
      expect(result).toEqual({
        id: 'user-1',
        email: 'new@example.com',
        fullName: 'New Parent',
        familyId: 'family-1',
        familyRole: 'OWNER',
      });
    });
  });

  describe('login', () => {
    it('throws the same error for an unknown email as for a wrong password', async () => {
      userRepositoryMock.findByEmail.mockResolvedValue(null);

      await expect(
        authService.login('ghost@example.com', 'whatever', {}),
      ).rejects.toBeInstanceOf(InvalidCredentialsException);
    });

    it('rejects an incorrect password without revealing which check failed', async () => {
      userRepositoryMock.findByEmail.mockResolvedValue({
        id: 'user-1',
        passwordHash: 'hashed',
        status: 'ACTIVE',
      });
      passwordServiceMock.verify.mockResolvedValue(false);

      await expect(
        authService.login('parent@example.com', 'wrong-password', {}),
      ).rejects.toBeInstanceOf(InvalidCredentialsException);
    });

    it('issues a token pair bound to the family on successful login', async () => {
      userRepositoryMock.findByEmail.mockResolvedValue({
        id: 'user-1',
        email: 'parent@example.com',
        fullName: 'Parent',
        passwordHash: 'hashed',
        status: 'ACTIVE',
      });
      passwordServiceMock.verify.mockResolvedValue(true);
      userRepositoryMock.findPrimaryFamilyMembership.mockResolvedValue({
        familyId: 'family-1',
        role: 'OWNER',
      });
      tokenServiceMock.issueTokenPair.mockResolvedValue({
        accessToken: 'access',
        refreshToken: 'refresh',
        accessTokenExpiresInSeconds: 900,
        refreshTokenExpiresInSeconds: 2_592_000,
      });

      const { tokens, user } = await authService.login('parent@example.com', 'correct', {
        ipAddress: '127.0.0.1',
      });

      expect(tokenServiceMock.issueTokenPair).toHaveBeenCalledWith(
        expect.objectContaining({ subjectId: 'user-1', actorType: 'USER', familyId: 'family-1' }),
      );
      expect(tokens.accessToken).toBe('access');
      expect(user.familyId).toBe('family-1');
      expect(userRepositoryMock.updateLastLoginAt).toHaveBeenCalledWith('user-1', expect.any(Date));
    });
  });

  describe('refresh', () => {
    it('rotates the refresh token: old one is consumed, a new pair is issued', async () => {
      tokenServiceMock.verifyAndConsumeRefreshToken.mockResolvedValue({
        payload: { sub: 'user-1', actorType: 'USER', familyId: 'family-1' },
        record: { id: 'old-token-id', familyTokenId: 'family-token-1' },
      });
      tokenServiceMock.issueTokenPair.mockResolvedValue({
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        accessTokenExpiresInSeconds: 900,
        refreshTokenExpiresInSeconds: 2_592_000,
      });

      const result = await authService.refresh('old-refresh-token', {});

      expect(tokenServiceMock.verifyAndConsumeRefreshToken).toHaveBeenCalledWith(
        'old-refresh-token',
      );
      expect(result.accessToken).toBe('new-access');
    });

    /** SA-002: without this the rotation chain would be broken into
     * unrelated single tokens and family-wide revocation could never
     * reach the attacker's descendant token. */
    it('carries the rotation lineage forward to the successor token', async () => {
      tokenServiceMock.verifyAndConsumeRefreshToken.mockResolvedValue({
        payload: { sub: 'user-1', actorType: 'USER', familyId: 'family-1' },
        record: { id: 'old-token-id', familyTokenId: 'family-token-1' },
      });
      tokenServiceMock.issueTokenPair.mockResolvedValue({
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        accessTokenExpiresInSeconds: 900,
        refreshTokenExpiresInSeconds: 2_592_000,
      });

      await authService.refresh('old-refresh-token', {});

      expect(tokenServiceMock.issueTokenPair).toHaveBeenCalledWith(
        expect.objectContaining({
          subjectId: 'user-1',
          actorType: 'USER',
          familyId: 'family-1',
          familyTokenId: 'family-token-1',
          replacesTokenId: 'old-token-id',
        }),
      );
    });
  });

  describe('logout (Sprint 9: now audited)', () => {
    it('revokes the token and records an audit event for a USER actor', async () => {
      tokenServiceMock.verifyAndConsumeRefreshToken.mockResolvedValue({
        payload: { sub: 'user-1', actorType: 'USER', familyId: 'family-1' },
        record: { id: 'old-token-id' },
      });

      await authService.logout('refresh-token');

      expect(auditServiceMock.record).toHaveBeenCalledWith(
        expect.objectContaining({
          actorType: 'USER',
          actorUserId: 'user-1',
          action: 'auth.logout',
          entityType: 'User',
          entityId: 'user-1',
        }),
      );
    });

    it('records a DEVICE-actor audit event without actorUserId for a device logout', async () => {
      tokenServiceMock.verifyAndConsumeRefreshToken.mockResolvedValue({
        payload: { sub: 'device-1', actorType: 'DEVICE', familyId: 'family-1' },
        record: { id: 'old-token-id' },
      });

      await authService.logout('refresh-token');

      expect(auditServiceMock.record).toHaveBeenCalledWith(
        expect.objectContaining({ actorType: 'DEVICE', actorUserId: undefined, entityType: 'Device' }),
      );
    });
  });
});
