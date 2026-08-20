/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
/**
 * ============================================================================
 * `GET /feature-flags` MUST NOT SERVE ONE FAMILY THE UUID OF ANOTHER.
 * ============================================================================
 *
 * THE DEFECT THIS FILE EXISTS FOR.
 *
 * `PrismaFeatureFlagRepository.listAll()` was `featureFlag.findMany()` with no
 * `select`, and `FeatureFlagsController.listAll()` returned those rows verbatim
 * behind `JwtAuthGuard` + `@ParentSurface()`. `FeatureFlag.enabledFamilyIds` is
 * a `String[] @db.Uuid` — the per-family rollout allow-list — and `familyId` is
 * the tenant key this entire API authorizes on. So any parent, in any family,
 * could call one unremarkable route and receive the family id of EVERY
 * household each flag had been switched on for, plus the names and descriptions
 * of features that had not shipped.
 *
 * It is the same defect as `GET /children` returning a child's PIN hash inside
 * the raw Prisma row, and it survived a cross-tenant probe suite that called
 * itself exhaustive — because that suite only probed routes carrying an id in
 * the path, and this route carries none. A collection route is exactly where a
 * cross-tenant leak hides. `cross-tenant-probe.e2e.spec.ts` now probes them.
 *
 * ---------------------------------------------------------------------------
 * WHY THE ASSERTIONS ARE SHAPED THE WAY THEY ARE.
 *
 * Asserting `expect(body[0].enabledFamilyIds).toBeUndefined()` would pin ONE
 * field name and let the NEXT column leak by simply being added to the model.
 * Every test below asserts the EXACT KEY SET of the response objects instead,
 * so a widened response is a failure whatever the new field is called. That is
 * the runtime half of the guarantee; the compile-time half is
 * `IFeatureFlagClientView` being the controller's declared return type.
 *
 * The first block needs no database and therefore always runs. The second boots
 * the REAL application against real PostgreSQL with two real families and real
 * signed tokens, and is the one that proves the property end to end.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');

import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { runAsSystemAsync } from '../../src/common/tenancy/system-context';
import { runWithTenant } from '../../src/common/tenancy/tenant-context';
import { FeatureFlagsController } from '../../src/modules/feature-flags/presentation/controllers/feature-flags.controller';
import { FeatureFlagService } from '../../src/modules/feature-flags/application/feature-flag.service';
import { FEATURE_FLAG_REPOSITORY } from '../../src/modules/feature-flags/domain/feature-flag.repository.port';
import {
  FEATURE_FLAG_KEY_SELECT,
  FEATURE_FLAG_ROSTER_SELECT,
} from '../../src/modules/feature-flags/domain/feature-flag.types';
import { PasswordService } from '../../src/modules/auth/application/services/password.service';
import { TokenService } from '../../src/modules/auth/application/services/token.service';
import { createTestPrismaService, integrationDatabaseUrl } from './prisma-test-client';

/** The complete, closed set of keys a parent may receive per flag. */
const ALLOWED_RESPONSE_KEYS = ['isEnabledForMe', 'key'];

const describeIfDb = integrationDatabaseUrl() ? describe : describe.skip;

// ===========================================================================
// 1. NO DATABASE REQUIRED — the projection itself
// ===========================================================================

describe('the feature-flag projection — the shape, with no database in the way', () => {
  /**
   * A repository stub that answers with EVERY column the table has, including
   * the allow-list. If the serialization boundary is doing its job, none of it
   * survives to the handler's return value. Against the old code — which handed
   * the repository's rows straight to the client — this fails, naming the
   * columns that escaped.
   */
  const OTHER_FAMILY_UUID = '11111111-1111-4111-8111-111111111111';
  const MY_FAMILY_UUID = '22222222-2222-4222-8222-222222222222';

  const repositoryStub = {
    findByKey: jest.fn(),
    listAll: jest.fn(),
    listKeysEnabledForFamily: jest.fn(),
    upsert: jest.fn(),
  };

  let controller: FeatureFlagsController;

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      controllers: [FeatureFlagsController],
      providers: [
        FeatureFlagService,
        { provide: FEATURE_FLAG_REPOSITORY, useValue: repositoryStub },
      ],
    }).compile();
    controller = moduleRef.get(FeatureFlagsController);

    repositoryStub.listAll.mockResolvedValue([
      { key: 'flag_global', isEnabledGlobally: true },
      { key: 'flag_others_only', isEnabledGlobally: false },
      { key: 'flag_mine', isEnabledGlobally: false },
    ]);
    repositoryStub.listKeysEnabledForFamily.mockImplementation(async (familyId: string) =>
      familyId === MY_FAMILY_UUID ? [{ key: 'flag_mine' }] : [],
    );
  });

  it('every entry carries EXACTLY {key, isEnabledForMe} — a new column cannot leak by being added', async () => {
    const body = await controller.listAll({ familyId: MY_FAMILY_UUID } as any);

    expect(body.length).toBe(3);
    for (const entry of body) {
      // The exact key set, not one field name. This is the assertion that a
      // future `FeatureFlag` column has to get past.
      expect(Object.keys(entry).sort()).toEqual(ALLOWED_RESPONSE_KEYS);
    }
  });

  it('the server takes the decision — the client is never handed the allow-list to evaluate itself', async () => {
    const body = await controller.listAll({ familyId: MY_FAMILY_UUID } as any);
    const decided = Object.fromEntries(body.map((f) => [f.key, f.isEnabledForMe]));

    expect(decided).toEqual({ flag_global: true, flag_others_only: false, flag_mine: true });

    // Only the caller's OWN family id is ever put to the database.
    expect(repositoryStub.listKeysEnabledForFamily).toHaveBeenCalledTimes(1);
    expect(repositoryStub.listKeysEnabledForFamily).toHaveBeenCalledWith(MY_FAMILY_UUID);
    expect(JSON.stringify(body)).not.toContain(OTHER_FAMILY_UUID);
  });

  it('a principal with no familyId sees only the globally-enabled flags, never an accidental match', async () => {
    const body = await controller.listAll({} as any);

    expect(repositoryStub.listKeysEnabledForFamily).not.toHaveBeenCalled();
    expect(Object.fromEntries(body.map((f) => [f.key, f.isEnabledForMe]))).toEqual({
      flag_global: true,
      flag_others_only: false,
      flag_mine: false,
    });
  });

  it('neither list projection names the allow-list column — it is not read on any list path', () => {
    expect(Object.keys(FEATURE_FLAG_ROSTER_SELECT).sort()).toEqual(['isEnabledGlobally', 'key']);
    expect(Object.keys(FEATURE_FLAG_KEY_SELECT)).toEqual(['key']);
  });
});

// ===========================================================================
// 2. THE REAL APPLICATION, TWO REAL FAMILIES, REAL POSTGRESQL
// ===========================================================================

describeIfDb('GET /feature-flags against the real application — one family, another family’s UUID', () => {
  let app: INestApplication;
  let http: any;
  let prisma: any;

  const stamp = Date.now();
  const flagKeys = {
    global: `probe_flag_global_${stamp}`,
    bOnly: `probe_flag_b_only_${stamp}`,
    off: `probe_flag_off_${stamp}`,
  };
  const familyIds: Record<'A' | 'B', string> = { A: '', B: '' };
  const tokens: Record<'A' | 'B', string> = { A: '', B: '' };
  const createdUserIds: string[] = [];

  /**
   * Families are seeded through Prisma and tokens minted with the
   * application's own `TokenService` rather than obtained from
   * `POST /auth/register`: the register throttle counter is IP-keyed in the
   * shared Redis and every e2e suite in one `--runInBand` run draws on the same
   * budget, so a suite that does not need it must not spend it.
   */
  const sys = (what: string, fn: () => Promise<any>): Promise<any> =>
    // `await fn()` and not `fn`: a PrismaPromise is lazy, so the query only
    // starts when it is awaited — awaiting it OUTSIDE this callback would run
    // it outside the SystemContext and the tenant extension would deny it.
    runAsSystemAsync('TEST_FIXTURE', `feature-flag exposure fixture: ${what}`, async () => await fn());

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(createTestPrismaService())
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
    http = app.getHttpServer();
    prisma = app.get(PrismaService);

    const tokenService = app.get(TokenService);
    const passwordService = app.get(PasswordService);

    for (const label of ['A', 'B'] as const) {
      const family = await sys(`family ${label}`, () =>
        prisma.family.create({ data: { name: `Flag Probe ${label} ${stamp}` }, select: { id: true } }),
      );
      familyIds[label] = family.id;

      const user = await sys(`parent ${label}`, async () =>
        prisma.user.create({
          data: {
            email: `flagprobe.${label.toLowerCase()}.${stamp}@example.com`,
            passwordHash: await passwordService.hash('Flag-Probe-Passw0rd!23'),
            fullName: `Flag Probe Parent ${label}`,
            termsAcceptedAt: new Date(),
            termsVersion: 'v1-placeholder',
          },
          select: { id: true },
        }),
      );
      createdUserIds.push(user.id);
      await sys(`membership ${label}`, () =>
        prisma.familyMember.create({
          data: { familyId: family.id, userId: user.id, role: 'OWNER' },
        }),
      );
      tokens[label] = (
        await runWithTenant({ familyId: family.id, actorType: 'USER', actorId: user.id }, () =>
          tokenService.issueTokenPair({
            subjectId: user.id,
            actorType: 'USER',
            familyId: family.id,
            familyRole: 'OWNER',
          }),
        )
      ).accessToken;
    }

    // The rollout state that used to be published to everybody.
    await sys('feature flags', async () => {
      await prisma.featureFlag.create({
        data: {
          key: flagKeys.global,
          description: 'UNRELEASED: probe global flag — this prose must not reach a parent.',
          isEnabledGlobally: true,
          enabledFamilyIds: [],
        },
      });
      await prisma.featureFlag.create({
        data: {
          key: flagKeys.bOnly,
          description: 'UNRELEASED: probe flag rolled out to family B only.',
          isEnabledGlobally: false,
          enabledFamilyIds: [familyIds.B],
        },
      });
      await prisma.featureFlag.create({
        data: {
          key: flagKeys.off,
          description: 'UNRELEASED: probe flag rolled out to nobody.',
          isEnabledGlobally: false,
          enabledFamilyIds: [],
        },
      });
    });
  }, 60_000);

  afterAll(async () => {
    if (prisma) {
      await sys('teardown', async () => {
        await prisma.featureFlag.deleteMany({ where: { key: { in: Object.values(flagKeys) } } });
        await prisma.family.deleteMany({ where: { id: { in: [familyIds.A, familyIds.B] } } });
        await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
      });
    }
    await app?.close();
  });

  const list = (label: 'A' | 'B') =>
    request(http).get('/feature-flags').set({ Authorization: `Bearer ${tokens[label]}` });

  it('the fixture is real — two distinct families, and family B is on a rollout list', () => {
    expect(familyIds.A).toBeTruthy();
    expect(familyIds.B).toBeTruthy();
    expect(familyIds.A).not.toBe(familyIds.B);
  });

  it("family A's response contains family B's UUID NOWHERE — not in a field, not anywhere in the body", async () => {
    const res = await list('A');
    expect(res.status).toBe(200);

    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain(familyIds.B);
    // And not the caller's own id either: this route has no reason to echo it.
    expect(raw).not.toContain(familyIds.A);
  }, 30_000);

  it('EVERY entry has exactly the keys {key, isEnabledForMe} — the whole response, not a sample', async () => {
    const res = await list('A');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(3);

    // Reported as a set of offending key-sets so a failure names what leaked.
    const offending = [
      ...new Set(
        res.body
          .map((entry: any) => Object.keys(entry).sort().join(','))
          .filter((keys: string) => keys !== ALLOWED_RESPONSE_KEYS.join(',')),
      ),
    ];
    expect(offending).toEqual([]);
  }, 30_000);

  it("the unreleased features' descriptions are not published to parents", async () => {
    const res = await list('A');
    expect(JSON.stringify(res.body)).not.toContain('UNRELEASED');
  }, 30_000);

  it('the entitlement is decided on the server: B sees its own flag on, A sees it off', async () => {
    const [a, b] = await Promise.all([list('A'), list('B')]);
    const decisionOf = (res: any, key: string) =>
      res.body.find((f: any) => f.key === key)?.isEnabledForMe;

    expect(decisionOf(a, flagKeys.bOnly)).toBe(false);
    expect(decisionOf(b, flagKeys.bOnly)).toBe(true);

    // The globally-enabled flag is on for both — proving the false above is a
    // real decision and not the route answering "off" to everything.
    expect(decisionOf(a, flagKeys.global)).toBe(true);
    expect(decisionOf(b, flagKeys.global)).toBe(true);

    expect(decisionOf(a, flagKeys.off)).toBe(false);
    expect(decisionOf(b, flagKeys.off)).toBe(false);
  }, 30_000);

  it('GET /feature-flags/:key agrees with the list — one boolean, no rollout state', async () => {
    const res = await request(http)
      .get(`/feature-flags/${flagKeys.bOnly}`)
      .set({ Authorization: `Bearer ${tokens.A}` });

    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['enabled']);
    expect(res.body.enabled).toBe(false);
  }, 30_000);
});
