import { Test } from '@nestjs/testing';
import { AuthService } from '../../src/modules/auth/application/services/auth.service';
import { PasswordService } from '../../src/modules/auth/application/services/password.service';
import { TokenService } from '../../src/modules/auth/application/services/token.service';
import { USER_REPOSITORY } from '../../src/modules/auth/application/ports/auth.repository.ports';
import { AuditService } from '../../src/modules/audit/application/audit.service';
import { AttributionService } from '../../src/modules/analytics/application/attribution.service';
import { ReferralService } from '../../src/modules/analytics/application/referral.service';
import { PilotEnrollmentService } from '../../src/modules/analytics/application/pilot-enrollment.service';
import { countryCatalogueProvider } from '../common/country-catalogue.testing';
import {
  EmailAlreadyRegisteredException,
  InvalidCredentialsException,
  PilotInviteRequiredException,
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

  // PHASE D (GROWTH). Both are called AFTER the family exists and neither may
  // fail a registration, which is exactly what the two tests at the bottom of
  // this file assert against these doubles.
  const attributionServiceMock = { captureAtRegistration: jest.fn() };
  const referralServiceMock = { registerReferral: jest.fn() };

  // G16. THE DEFAULT IS THE DISABLED GATE, and that is the point: every other
  // test in this file runs against it and still passes, which is precisely the
  // "the flag defaults to off, so nothing changes for existing families" claim.
  const pilotServiceMock = { evaluate: jest.fn(), redeem: jest.fn() };
  const PILOT_DISABLED = {
    decision: 'PILOT_DISABLED' as const,
    allowed: true,
    cohortId: null,
    inviteId: null,
    // F1. No invitation means no operator-set country; registration falls back
    // to what the client claimed, which for most of this file is nothing.
    inviteCountryCode: null,
  };

  let authService: AuthService;

  beforeEach(async () => {
    jest.clearAllMocks();
    attributionServiceMock.captureAtRegistration.mockResolvedValue('ORGANIC');
    referralServiceMock.registerReferral.mockResolvedValue({ bound: true, reason: null });
    pilotServiceMock.evaluate.mockResolvedValue(PILOT_DISABLED);
    pilotServiceMock.redeem.mockResolvedValue(true);

    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: USER_REPOSITORY, useValue: userRepositoryMock },
        { provide: PasswordService, useValue: passwordServiceMock },
        { provide: TokenService, useValue: tokenServiceMock },
        { provide: AuditService, useValue: auditServiceMock },
        { provide: AttributionService, useValue: attributionServiceMock },
        { provide: ReferralService, useValue: referralServiceMock },
        { provide: PilotEnrollmentService, useValue: pilotServiceMock },
        // F1. The REAL catalogue service over a fake two-row `countries` table,
        // so the country and country/timezone rules asserted below are the ones
        // production runs, not a double's idea of them.
        countryCatalogueProvider(),
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

    // ====================================================================
    // G16 — THE CONTROLLED-PILOT GATE AT THE REGISTRATION BOUNDARY.
    //
    // The gate's own decision logic is tested in test/analytics/pilot-gate.spec.ts
    // and its constraints against real PostgreSQL in
    // test/database/pilot-cohorts.integration.spec.ts. What is asserted HERE is
    // only what AuthService does with the answer — because the expensive mistake
    // is not a wrong decision, it is a correct decision applied at the wrong
    // moment and leaving an account behind.
    // ====================================================================

    it('G16: the flag defaults to OFF — the gate is consulted and nothing changes', async () => {
      userRepositoryMock.findByEmail.mockResolvedValue(null);
      passwordServiceMock.hash.mockResolvedValue('hashed-password');
      userRepositoryMock.createParentWithFamily.mockResolvedValue({
        user: { id: 'user-1', email: 'new@example.com', fullName: 'New Parent' },
        family: { id: 'family-1' },
        membership: { role: 'OWNER' },
      });

      await authService.register({
        email: 'new@example.com',
        password: 'Sup3rSecret!',
        fullName: 'New Parent',
        acceptedTerms: true,
      });

      // Consulted on every registration — the gate is not conditional on a
      // caller remembering to ask for it.
      expect(pilotServiceMock.evaluate).toHaveBeenCalledTimes(1);
      // Disabled means the account is created exactly as before...
      expect(userRepositoryMock.createParentWithFamily).toHaveBeenCalledTimes(1);
      // ...and no invitation is redeemed, because there is none.
      expect(pilotServiceMock.redeem).not.toHaveBeenCalled();
    });

    it('G16: an UNINVITED family in a pilot country is refused, and NO account is created', async () => {
      userRepositoryMock.findByEmail.mockResolvedValue(null);
      pilotServiceMock.evaluate.mockResolvedValue({
        decision: 'NOT_INVITED',
        allowed: false,
        cohortId: null,
        inviteId: null,
      });

      await expect(
        authService.register({
          email: 'uninvited@example.com',
          password: 'Sup3rSecret!',
          fullName: 'Uninvited Parent',
          acceptedTerms: true,
          attribution: { countryCode: 'SA' },
        }),
      ).rejects.toBeInstanceOf(PilotInviteRequiredException);

      // THE ASSERTION THAT MATTERS. A refusal after `createParentWithFamily`
      // would leave a User and a Family behind, and a gate that admits the
      // household it just refused is not a gate.
      expect(userRepositoryMock.createParentWithFamily).not.toHaveBeenCalled();
      // Nor is anything else written: no password hashed, no audit, no
      // attribution, no referral.
      expect(passwordServiceMock.hash).not.toHaveBeenCalled();
      expect(auditServiceMock.record).not.toHaveBeenCalled();
      expect(attributionServiceMock.captureAtRegistration).not.toHaveBeenCalled();
      expect(referralServiceMock.registerReferral).not.toHaveBeenCalled();
    });

    it('G16: an already-redeemed invitation is refused the same way', async () => {
      userRepositoryMock.findByEmail.mockResolvedValue(null);
      pilotServiceMock.evaluate.mockResolvedValue({
        decision: 'INVITE_ALREADY_REDEEMED',
        allowed: false,
        cohortId: null,
        inviteId: null,
      });

      await expect(
        authService.register({
          email: 'used@example.com',
          password: 'Sup3rSecret!',
          fullName: 'Second Household',
          acceptedTerms: true,
          attribution: { countryCode: 'EG' },
        }),
      ).rejects.toBeInstanceOf(PilotInviteRequiredException);

      expect(userRepositoryMock.createParentWithFamily).not.toHaveBeenCalled();
    });

    it('G16: an INVITED family registers, and the invitation is redeemed against the new family', async () => {
      userRepositoryMock.findByEmail.mockResolvedValue(null);
      passwordServiceMock.hash.mockResolvedValue('hashed-password');
      userRepositoryMock.createParentWithFamily.mockResolvedValue({
        user: { id: 'user-9', email: 'invited@example.com', fullName: 'Invited Parent' },
        family: { id: 'family-9' },
        membership: { role: 'OWNER' },
      });
      pilotServiceMock.evaluate.mockResolvedValue({
        decision: 'INVITED',
        allowed: true,
        cohortId: 'pilot-2026-q1',
        inviteId: 'invite-9',
      });

      const result = await authService.register({
        email: 'Invited@Example.com',
        password: 'Sup3rSecret!',
        fullName: 'Invited Parent',
        acceptedTerms: true,
        attribution: { countryCode: 'SA' },
      });

      expect(result.familyId).toBe('family-9');
      // The gate is asked with the address as given and the reported country;
      // normalisation is the gate's own job, tested where it lives.
      expect(pilotServiceMock.evaluate).toHaveBeenCalledWith('Invited@Example.com', 'SA');
      // Redeemed against the family this transaction just created — never an id
      // from the request.
      expect(pilotServiceMock.redeem).toHaveBeenCalledWith('invite-9', 'family-9');
    });

    it('G16: a failure to record the enrolment does NOT fail the registration', async () => {
      userRepositoryMock.findByEmail.mockResolvedValue(null);
      passwordServiceMock.hash.mockResolvedValue('hashed-password');
      userRepositoryMock.createParentWithFamily.mockResolvedValue({
        user: { id: 'user-9', email: 'invited@example.com', fullName: 'Invited Parent' },
        family: { id: 'family-9' },
        membership: { role: 'OWNER' },
      });
      pilotServiceMock.evaluate.mockResolvedValue({
        decision: 'INVITED',
        allowed: true,
        cohortId: 'pilot-2026-q1',
        inviteId: 'invite-9',
      });
      // Lost the race for the invitation, or it was withdrawn in between.
      pilotServiceMock.redeem.mockResolvedValue(false);

      const result = await authService.register({
        email: 'invited@example.com',
        password: 'Sup3rSecret!',
        fullName: 'Invited Parent',
        acceptedTerms: true,
        attribution: { countryCode: 'SA' },
      });

      // The household keeps the account it legitimately created. An unrecorded
      // cohort label is a reporting problem, not a reason to delete a family.
      expect(result.familyId).toBe('family-9');
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
