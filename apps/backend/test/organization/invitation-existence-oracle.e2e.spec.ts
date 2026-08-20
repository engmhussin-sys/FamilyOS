/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * ===========================================================================
 * F1 — `POST /organizations/invitations/:invitationId/accept` WAS AN EXISTENCE
 * ORACLE OVER EVERY ORGANIZATION'S INVITATIONS. THIS IS THE PROOF IT IS NOT.
 * ===========================================================================
 *
 * THE DEFECT, AS THE CROSS-TENANT PROBE RECORDED IT
 * -------------------------------------------------
 * `organization.service.ts` verified in this order: exists (404 if not) ->
 * status (400 if not PENDING) -> expiry (400 if past) -> IS IT YOURS (403).
 * The one check that establishes any entitlement at all was LAST, so three
 * answers were handed to a caller who had proved nothing:
 *
 *   unknown id             -> 404 «Invitation "…" not found.»
 *   real id, not yours     -> 403 «…sent to a different email address.»
 *   real id, already used  -> 400 «This invitation is accepted and can no
 *                                  longer be accepted.»
 *
 * Three distinguishable answers is a read oracle. Any authenticated parent
 * could walk invitation ids and learn, for organizations they have nothing to
 * do with, which ids exist and what state each is in — with no rate of
 * discovery beyond the endpoint throttle.
 *
 * WHAT THIS SUITE ASSERTS, AND WHY IT IS AT THE HTTP LAYER
 * --------------------------------------------------------
 * The property is not "the service throws NotFoundException". It is that the
 * BYTES ON THE WIRE are the same. A unit assertion on the exception class
 * would pass while `GlobalExceptionFilter` rendered two different `code`s,
 * two different `message`s or two different `messageAr`s — and the client
 * receives the rendered body, not the class. So the real controller, the real
 * service and the SAME `applyGlobalHttpPipeline` that `main.ts` calls are
 * booted here, and the two responses are compared field by field.
 *
 * THE FOUR FIELDS THAT ARE STRIPPED BEFORE COMPARING, AND WHY THAT IS NOT A
 * WEAKENING. `requestId`, `correlationId` and `timestamp` are minted per
 * request and differ between ANY two calls, including two identical ones.
 * `path` echoes the URL THE CALLER ITSELF SENT — the caller already knows
 * which id it asked about, and the cross-tenant probe subtracts the request
 * URL from its disclosure search for exactly this reason
 * (`cross-tenant-probe.e2e.spec.ts:826`). Everything that could carry
 * information ABOUT THE ROW — status, `code`, `message`, `messageAr`,
 * `details` — is compared verbatim, and a separate assertion below proves the
 * invitation id appears in no field of the body at all.
 */
import { Controller, INestApplication, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');

import { applyGlobalHttpPipeline } from '../../src/common/http/global-pipeline';
import { CorrelationIdMiddleware } from '../../src/common/middleware/correlation-id.middleware';
import { OrganizationController } from '../../src/modules/organization/presentation/controllers/organization.controller';
import { OrganizationService } from '../../src/modules/organization/application/services/organization.service';
import { CampaignRedemptionService } from '../../src/modules/organization/application/services/campaign-redemption.service';
import { ORGANIZATION_REPOSITORY } from '../../src/modules/organization/application/ports/organization.repository.port';
import { RBAC_ENGINE } from '../../src/modules/organization/application/ports/rbac-engine.port';
import { POLICY_ENGINE } from '../../src/modules/organization/application/ports/policy-engine.port';
import { AuditService } from '../../src/modules/audit/application/audit.service';
import { USER_REPOSITORY } from '../../src/modules/auth/application/ports/auth.repository.ports';
import { JwtAuthGuard } from '../../src/modules/auth/presentation/guards/jwt-auth.guard';

jest.mock('@sentry/node', () => ({ captureException: jest.fn(), init: jest.fn() }));

/** A real id, belonging to an organization the caller has nothing to do with. */
const VICTIM_INVITATION_ID = '11111111-1111-4111-8111-111111111111';
/** An id that exists nowhere. */
const NONEXISTENT_INVITATION_ID = '22222222-2222-4222-8222-222222222222';

const CALLER = { sub: 'user-outsider', actorType: 'USER', familyId: 'fam-outsider' };

const victimInvitation = (overrides: Record<string, unknown> = {}) => ({
  id: VICTIM_INVITATION_ID,
  organizationId: 'org-someone-else',
  email: 'principal@another-school.example',
  role: 'MEMBER',
  status: 'PENDING',
  expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  invitedByUserId: 'inviter-of-another-org',
  ...overrides,
});

/** Everything that varies between any two HTTP calls, identical or not. */
const REQUEST_SCOPED_FIELDS = ['requestId', 'correlationId', 'timestamp', 'path'] as const;

const resourceFacingBody = (body: any): Record<string, unknown> => {
  const copy = { ...body };
  for (const field of REQUEST_SCOPED_FIELDS) delete copy[field];
  return copy;
};

const repositoryMock = {
  findInvitationById: jest.fn(),
  acceptInvitation: jest.fn(),
};
const userRepositoryMock = { findById: jest.fn() };
const rbacMock = { getRole: jest.fn(), hasPermission: jest.fn() };

/**
 * The REAL controller and the REAL service, with only the ports behind them
 * stubbed. `CorrelationIdMiddleware` is applied because the filter reads
 * `request.correlationId` — without it both responses would share the literal
 * `'unknown'` and the suite would be proving less than it claims.
 */
@Module({
  controllers: [OrganizationController],
  providers: [
    OrganizationService,
    { provide: ORGANIZATION_REPOSITORY, useValue: repositoryMock },
    { provide: RBAC_ENGINE, useValue: rbacMock },
    { provide: POLICY_ENGINE, useValue: { getPolicy: jest.fn(), setPolicy: jest.fn(), getEffectivePolicy: jest.fn() } },
    { provide: AuditService, useValue: { record: jest.fn() } },
    { provide: USER_REPOSITORY, useValue: userRepositoryMock },
    { provide: CampaignRedemptionService, useValue: { redeem: jest.fn() } },
  ],
})
class ProbeModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}

describe('F1 — the invitation-accept route is not an existence oracle', () => {
  let app: INestApplication;
  let http: any;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ProbeModule] })
      // AUTHENTICATION IS NOT WHAT IS UNDER TEST — the oracle was available to
      // any genuinely authenticated parent, so the caller here IS one.
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (context: any) => {
          context.switchToHttp().getRequest().user = CALLER;
          return true;
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    applyGlobalHttpPipeline(app);
    await app.init();
    http = app.getHttpServer();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // The caller is a real, authenticated user — and NOT the person any of
    // these invitations was addressed to.
    userRepositoryMock.findById.mockResolvedValue({
      id: CALLER.sub,
      email: 'outsider@example.com',
    });
  });

  const accept = (invitationId: string) =>
    request(http).post(`/api/v1/organizations/invitations/${invitationId}/accept`).send({});

  /**
   * THE CENTRAL ASSERTION. Each case seeds ONE real invitation in a state the
   * old code answered differently, asks about it, then asks the identical
   * question about an id that exists nowhere, and requires the two answers to
   * be the same bytes.
   *
   * `PENDING` is the case that used to answer 403; the other three used to
   * answer 400 — four distinguishable states, now one.
   */
  it.each([
    ['PENDING (used to answer 403 «sent to a different email address»)', {}],
    ['ACCEPTED (used to answer 400 «this invitation is accepted»)', { status: 'ACCEPTED' }],
    ['REVOKED (used to answer 400 «this invitation is revoked»)', { status: 'REVOKED' }],
    ['EXPIRED (used to answer 400 «this invitation has expired»)', { expiresAt: new Date(Date.now() - 1000) }],
  ])(
    'a %s invitation the caller may not act on is answered byte-identically to one that does not exist',
    async (_label, overrides) => {
      repositoryMock.findInvitationById.mockImplementation(async (id: string) =>
        id === VICTIM_INVITATION_ID ? victimInvitation(overrides as Record<string, unknown>) : null,
      );

      const real = await accept(VICTIM_INVITATION_ID);
      const control = await accept(NONEXISTENT_INVITATION_ID);

      // Same status.
      expect(real.status).toBe(control.status);
      expect(real.status).toBe(404);

      // Same body, field for field, and byte for byte once serialised.
      expect(resourceFacingBody(real.body)).toEqual(resourceFacingBody(control.body));
      expect(JSON.stringify(resourceFacingBody(real.body))).toBe(
        JSON.stringify(resourceFacingBody(control.body)),
      );

      // And the four stripped fields really are the only difference: every
      // other key exists in both, with the same value.
      expect(Object.keys(real.body).sort()).toEqual(Object.keys(control.body).sort());

      // The write never happened, in either case.
      expect(repositoryMock.acceptInvitation).not.toHaveBeenCalled();
    },
  );

  /**
   * THE SAME AMOUNT OF WORK, WHICHEVER IT WAS.
   *
   * Identical bytes returned after a measurably different number of database
   * round trips is still an oracle — the old code short-circuited on a missing
   * invitation and never read the user, so "not found" was ONE query and "not
   * yours" was TWO. Asserting the call counts is the deterministic form of
   * "same timing class": a wall-clock assertion in CI would be a flake
   * generator, while a query that is not issued cannot be timed.
   */
  it('issues the same repository reads whether the invitation exists or not', async () => {
    repositoryMock.findInvitationById.mockImplementation(async (id: string) =>
      id === VICTIM_INVITATION_ID ? victimInvitation() : null,
    );

    await accept(VICTIM_INVITATION_ID);
    const afterReal = {
      invitations: repositoryMock.findInvitationById.mock.calls.length,
      users: userRepositoryMock.findById.mock.calls.length,
    };

    jest.clearAllMocks();
    userRepositoryMock.findById.mockResolvedValue({ id: CALLER.sub, email: 'outsider@example.com' });

    await accept(NONEXISTENT_INVITATION_ID);
    const afterControl = {
      invitations: repositoryMock.findInvitationById.mock.calls.length,
      users: userRepositoryMock.findById.mock.calls.length,
    };

    expect(afterReal).toEqual(afterControl);
    expect(afterReal).toEqual({ invitations: 1, users: 1 });
  });

  /** Nothing in the body names the row, so there is nothing to correlate. */
  it('names neither the invitation id nor the organization it belongs to', async () => {
    repositoryMock.findInvitationById.mockResolvedValue(victimInvitation());

    const res = await accept(VICTIM_INVITATION_ID);

    const bodyWithoutPath = JSON.stringify(resourceFacingBody(res.body));
    expect(bodyWithoutPath).not.toContain(VICTIM_INVITATION_ID);
    expect(bodyWithoutPath).not.toContain('org-someone-else');
    expect(bodyWithoutPath).not.toContain('principal@another-school.example');
    expect(bodyWithoutPath).not.toContain('PENDING');
    expect(bodyWithoutPath).not.toContain('pending');
  });

  /** B3: the refusal is still a real, Arabic, non-punitive sentence. */
  it('answers with the B3 contract — a code and an Arabic sentence, not a bare status', async () => {
    repositoryMock.findInvitationById.mockResolvedValue(null);

    const res = await accept(NONEXISTENT_INVITATION_ID);

    expect(res.body.code).toBe('INVITATION_NOT_FOUND');
    expect(res.body.messageAr).toBe(
      'هذه الدعوة غير متاحة. اطلب من الجهة التي دعتك إرسال دعوة جديدة إلى بريدك.',
    );
    expect(res.body.messageAr).not.toMatch(/[A-Za-z0-9]/);
  });

  /**
   * THE FEATURE IS NOT FLATTENED — the fix is an ORDER change, not a blanket
   * 404. The person the invitation was actually sent to still learns why it
   * will not work, because they received the id by email and knowing it exists
   * tells them nothing they did not already know.
   */
  describe('the person it WAS sent to still gets a real answer', () => {
    beforeEach(() => {
      userRepositoryMock.findById.mockResolvedValue({
        id: CALLER.sub,
        email: 'principal@another-school.example',
      });
    });

    it('is told the invitation has expired — a 400, not the flat 404', async () => {
      repositoryMock.findInvitationById.mockResolvedValue(
        victimInvitation({ expiresAt: new Date(Date.now() - 1000) }),
      );

      const res = await accept(VICTIM_INVITATION_ID);

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('expired');
    });

    it('is told it was already accepted — a 400, not the flat 404', async () => {
      repositoryMock.findInvitationById.mockResolvedValue(victimInvitation({ status: 'ACCEPTED' }));

      const res = await accept(VICTIM_INVITATION_ID);

      expect(res.status).toBe(400);
    });

    it('can still accept a valid invitation end to end', async () => {
      repositoryMock.findInvitationById.mockResolvedValue(victimInvitation());
      rbacMock.getRole.mockResolvedValue('OWNER');
      repositoryMock.acceptInvitation.mockResolvedValue({
        id: 'mem-1',
        organizationId: 'org-someone-else',
        userId: CALLER.sub,
        role: 'MEMBER',
      });

      const res = await accept(VICTIM_INVITATION_ID);

      expect(res.status).toBe(201);
      expect(res.body.id).toBe('mem-1');
      expect(repositoryMock.acceptInvitation).toHaveBeenCalledWith(VICTIM_INVITATION_ID, CALLER.sub);
    });
  });
});
