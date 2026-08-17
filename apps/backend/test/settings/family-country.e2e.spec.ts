/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
/**
 * F1 — `Family.countryCode`, END TO END, AGAINST REAL POSTGRESQL AND THE
 * DEPLOYED HTTP PIPELINE.
 *
 * WHY THIS SUITE BOOTS THROUGH `applyGlobalHttpPipeline` AND NOT A HAND-ROLLED
 * `ValidationPipe`. Two of the properties under test only EXIST in the deployed
 * pipeline:
 *
 *   - `forbidNonWhitelisted: true`. The defect F1 fixes is that `countryCode`
 *     was not on `UpdateSettingsDto`, and under that flag an undeclared field is
 *     not ignored — it is a 400 for the WHOLE request. A looser pipe would have
 *     silently stripped it and this suite would have proved nothing, which is
 *     exactly the PA-B-022 failure mode.
 *   - `GlobalExceptionFilter`. The B3 envelope (`code` + `messageAr`) is
 *     installed by that filter and by nothing else. Asserting the error shape
 *     without it would assert Nest's default shape, which no client receives.
 *
 * EVERY NUMBER AND EVERY STATUS BELOW IS EXECUTED. Nothing is asserted about
 * behaviour that was only read.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');

import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { applyGlobalHttpPipeline, API_GLOBAL_PREFIX } from '../../src/common/http/global-pipeline';
import { createTenantExtension } from '../../src/common/tenancy/tenant.extension';
import { runAsSystemAsync } from '../../src/common/tenancy/system-context';
import { integrationDatabaseUrl } from '../tenancy/prisma-test-client';
import { familyCountryWhere, PLATFORM_SCOPE } from '../../src/modules/analytics/domain/country-attribution';

const describeIfDb = integrationDatabaseUrl() ? describe : describe.skip;
const V = `/${API_GLOBAL_PREFIX}`;

function offlinePrismaService(): any {
  const url = process.env.INTEGRATION_DATABASE_URL as string;
  if (process.env.PRISMA_DRIVER_ADAPTER === 'pg') {
    const { PrismaClient } = require('@prisma/client/wasm');
    const { PrismaPg } = require('@prisma/adapter-pg');
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: url });
    const base = new PrismaClient({ adapter: new PrismaPg(pool) });
    const extended = base.$extends(createTenantExtension());
    extended.onModuleInit = async () => undefined;
    extended.onModuleDestroy = async () => {
      await base.$disconnect();
      await pool.end();
    };
    return extended;
  }
  const { PrismaClient } = require('@prisma/client');
  const base = new PrismaClient({ datasources: { db: { url } } });
  const extended = base.$extends(createTenantExtension());
  extended.onModuleInit = async () => base.$connect();
  extended.onModuleDestroy = async () => base.$disconnect();
  return extended;
}

/**
 * EVERY error body a client can receive must carry these. Asserted on each
 * refusal below rather than once, because the point of F1's typed errors is
 * that a household never sees a database constraint name or an English
 * fallback — and "usually" is not the guarantee.
 */
function assertB3Envelope(body: any, code: string): void {
  expect(body.code).toBe(code);
  expect(typeof body.messageAr).toBe('string');
  expect(body.messageAr.length).toBeGreaterThan(0);
  // Arabic, not a transliterated enum leaking through the messageAr field.
  expect(body.messageAr).toMatch(/[؀-ۿ]/);
  expect(body.messageAr).not.toContain(code);
  // THE REGRESSION THIS GUARDS: migration 0022 installed a REAL foreign key.
  // Without a check in front of it, an unsupported code reaches Postgres and
  // Prisma raises a non-HttpException, which the filter turns into a 500 whose
  // log line is a constraint name. None of that may reach the wire.
  const json = JSON.stringify(body);
  expect(json).not.toContain('families_country_code_fkey');
  expect(json).not.toContain('Prisma');
  expect(json).not.toContain('Foreign key');
}

describeIfDb('F1 — Family.countryCode end to end (real PostgreSQL, real deployed pipeline)', () => {
  let app: INestApplication;
  let http: any;
  let prisma: any;

  const stamp = Date.now();
  const createdFamilies: string[] = [];

  const sys = (what: string, fn: () => Promise<any>): Promise<any> =>
    runAsSystemAsync('TEST_FIXTURE', `F1 country suite: ${what}`, async () => await fn());

  /**
   * `/auth/register` is throttled at 5/min per IP and that limit is a real
   * control — it is CLEARED, never lowered. Lowering a production defence to
   * make a suite green trades the defence for a tick; clearing the counter
   * leaves the limit exactly where it is. Same block `b5-mobile-contract` and
   * `event-pipeline` already use.
   */
  async function clearThrottle(): Promise<void> {
    const Redis = require('ioredis');
    const client = new Redis(process.env.REDIS_URL as string);
    const keys = await client.keys('throttle:*');
    if (keys.length > 0) await client.del(...keys);
    await client.quit();
  }

  interface Registered {
    status: number;
    body: any;
  }

  async function register(label: string, extra: Record<string, unknown> = {}): Promise<Registered> {
    await clearThrottle();
    const res = await request(http)
      .post(`${V}/auth/register`)
      .send({
        email: `f1.${label}.${stamp}@example.test`,
        password: 'F1-Country-Passw0rd!23',
        fullName: `F1 Parent ${label}`,
        acceptedTerms: true,
        ...extra,
      });
    if (res.status === 201 && res.body?.familyId) createdFamilies.push(res.body.familyId);
    return { status: res.status, body: res.body };
  }

  async function tokenFor(label: string): Promise<string> {
    const login = await request(http)
      .post(`${V}/auth/login`)
      .send({ email: `f1.${label}.${stamp}@example.test`, password: 'F1-Country-Passw0rd!23' });
    expect(login.status).toBe(200);
    return login.body.tokens.accessToken;
  }

  const familyRow = (id: string): Promise<any> =>
    sys('read family', () =>
      prisma.family.findUnique({ where: { id }, select: { countryCode: true, timezone: true } }),
    );

  beforeAll(async () => {
    await clearThrottle();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useFactory({ factory: offlinePrismaService })
      .compile();

    app = moduleRef.createNestApplication();
    // THE DEPLOYED PIPELINE, not an approximation of it. See the file docstring.
    applyGlobalHttpPipeline(app);
    await app.init();
    http = app.getHttpServer();
    prisma = app.get(PrismaService);

    // Migration 0014 seeds EG and SA. Asserted rather than assumed, because
    // every expectation below is about what the CATALOGUE says, and a suite that
    // silently ran against an empty catalogue would prove nothing.
    const countries = await sys('read catalogue', () =>
      prisma.country.findMany({ where: { isActive: true }, select: { code: true } }),
    );
    expect(countries.map((c: any) => c.code).sort()).toEqual(expect.arrayContaining(['EG', 'SA']));
  }, 120_000);

  afterAll(async () => {
    if (app) await app.close();
  });

  // =========================================================================
  // 1. PATCH /settings — the field whose ABSENCE was the defect
  // =========================================================================
  describe('1. PATCH /settings accepts, normalises and persists the country', () => {
    let token = '';

    beforeAll(async () => {
      const reg = await register('settings');
      expect(reg.status).toBe(201);
      token = await tokenFor('settings');
    }, 60_000);

    const patch = (body: Record<string, unknown>) =>
      request(http).patch(`${V}/settings`).set({ Authorization: `Bearer ${token}` }).send(body);

    it("a household with no country reads back countryCode: null — 'not set' is a real answer, not a missing field", async () => {
      const res = await request(http).get(`${V}/settings`).set({ Authorization: `Bearer ${token}` });
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('countryCode');
      expect(res.body.countryCode).toBeNull();
    });

    it("countryCode: 'SA' is PERSISTED and ECHOED — the whole point of F1", async () => {
      const res = await patch({ countryCode: 'SA' });
      expect(res.status).toBe(200);
      expect(res.body.countryCode).toBe('SA');

      // Echoed is not enough: read the row back through a separate connection
      // path, because a service that returned its own input without writing
      // would pass an echo-only assertion.
      const get = await request(http).get(`${V}/settings`).set({ Authorization: `Bearer ${token}` });
      expect(get.body.countryCode).toBe('SA');
    });

    it("lowercase 'eg' normalises to 'EG' rather than being refused or stored as sent", async () => {
      const res = await patch({ countryCode: 'eg' });
      expect(res.status).toBe(200);
      expect(res.body.countryCode).toBe('EG');
    });

    it('a code with surrounding whitespace normalises too', async () => {
      const res = await patch({ countryCode: ' sa ' });
      expect(res.status).toBe(200);
      expect(res.body.countryCode).toBe('SA');
    });

    it("'ZZ' — well-formed, not a market — is a TYPED 400 with the B3 envelope, never a database error", async () => {
      const res = await patch({ countryCode: 'ZZ' });
      expect(res.status).toBe(400);
      assertB3Envelope(res.body, 'COUNTRY_NOT_SUPPORTED');
    });

    it("'US' is refused the same way — the list is data, and this deployment does not have that row", async () => {
      const res = await patch({ countryCode: 'US' });
      expect(res.status).toBe(400);
      assertB3Envelope(res.body, 'COUNTRY_NOT_SUPPORTED');
    });

    it('a refused country leaves the previously stored one untouched', async () => {
      await patch({ countryCode: 'EG' });
      const refused = await patch({ countryCode: 'ZZ' });
      expect(refused.status).toBe(400);
      const get = await request(http).get(`${V}/settings`).set({ Authorization: `Bearer ${token}` });
      expect(get.body.countryCode).toBe('EG');
    });

    it('a malformed code is refused by the DTO shape check, before any database round trip', async () => {
      for (const bad of ['E', 'EGY', '1234']) {
        const res = await patch({ countryCode: bad });
        expect(res.status).toBe(400);
        // The pipeline's own code — this refusal never reached the service.
        expect(res.body.code).toBe('VALIDATION_FAILED');
        expect(typeof res.body.messageAr).toBe('string');
      }
    });

    it('AN INACTIVE MARKET IS AS REFUSED AS AN ABSENT ONE — `is_active` is how a market is closed', async () => {
      // `countries.is_active = false` is how a market is closed without deleting
      // rows that prices and subscriptions still point at. The foreign key alone
      // would NOT catch this: the row still exists, so the FK is satisfied.
      await sys('close SA', () =>
        prisma.country.update({ where: { code: 'SA' }, data: { isActive: false } }),
      );
      try {
        const res = await patch({ countryCode: 'SA' });
        expect(res.status).toBe(400);
        assertB3Envelope(res.body, 'COUNTRY_NOT_SUPPORTED');
      } finally {
        await sys('reopen SA', () =>
          prisma.country.update({ where: { code: 'SA' }, data: { isActive: true } }),
        );
      }

      // And it is accepted again the moment the market reopens — proving the
      // check reads the table on every request rather than a cached list.
      const reopened = await patch({ countryCode: 'SA' });
      expect(reopened.status).toBe(200);
      expect(reopened.body.countryCode).toBe('SA');
    });
  });

  // =========================================================================
  // 2. THE COUNTRY / TIMEZONE RULE
  // =========================================================================
  describe('2. the country and the calendar cannot disagree', () => {
    let token = '';

    beforeAll(async () => {
      const reg = await register('calendar');
      expect(reg.status).toBe(201);
      token = await tokenFor('calendar');
    }, 60_000);

    const patch = (body: Record<string, unknown>) =>
      request(http).patch(`${V}/settings`).set({ Authorization: `Bearer ${token}` }).send(body);

    it('setting ONLY the country DERIVES the calendar from it — the server decides, the client need not know the mapping', async () => {
      // Before F1 this household would have kept the schema default "UTC" while
      // claiming to be in Egypt, and every business date — every streak, every
      // daily limit, every reward idempotency key — would have been computed on
      // a day boundary two hours away from the parent's own midnight.
      const res = await patch({ countryCode: 'EG' });
      expect(res.status).toBe(200);
      expect(res.body.countryCode).toBe('EG');
      expect(res.body.timezone).toBe('Africa/Cairo');
    });

    it('and the Saudi mapping is the other one from the SAME catalogue, not a second literal', async () => {
      const res = await patch({ countryCode: 'SA' });
      expect(res.status).toBe(200);
      expect(res.body.timezone).toBe('Asia/Riyadh');
    });

    it('sending the CORRECT pair together is accepted', async () => {
      const res = await patch({ countryCode: 'EG', timezone: 'Africa/Cairo' });
      expect(res.status).toBe(200);
      expect(res.body.countryCode).toBe('EG');
      expect(res.body.timezone).toBe('Africa/Cairo');
    });

    it('a tzdata ALIAS for the right zone is accepted and stored canonically', async () => {
      // "Egypt" is a real tzdata link that ICU resolves to Africa/Cairo. A raw
      // string comparison would reject a caller who was right.
      const res = await patch({ countryCode: 'EG', timezone: 'Egypt' });
      expect(res.status).toBe(200);
      expect(res.body.timezone).toBe('Africa/Cairo');
    });

    it('A CLIENT MAY NOT ASSERT A CONTRADICTION: country + a disagreeing timezone is a typed 400', async () => {
      const res = await patch({ countryCode: 'SA', timezone: 'Africa/Cairo' });
      expect(res.status).toBe(400);
      assertB3Envelope(res.body, 'COUNTRY_TIMEZONE_MISMATCH');
    });

    it('the rule does not depend on how the client BATCHED its writes', async () => {
      // A household that is already SA and now patches only the timezone is
      // producing exactly the incoherent row the rule exists to prevent.
      // Enforcing only when both fields arrive together would make the guarantee
      // an accident of client implementation.
      await patch({ countryCode: 'SA' });
      const res = await patch({ timezone: 'Africa/Cairo' });
      expect(res.status).toBe(400);
      assertB3Envelope(res.body, 'COUNTRY_TIMEZONE_MISMATCH');
    });

    it('a household with NO country may still set any valid timezone — the rule constrains a pair, not a field', async () => {
      const reg = await register('nocountry-tz');
      expect(reg.status).toBe(201);
      const other = await tokenFor('nocountry-tz');
      const res = await request(http)
        .patch(`${V}/settings`)
        .set({ Authorization: `Bearer ${other}` })
        .send({ timezone: 'Africa/Cairo' });
      expect(res.status).toBe(200);
      expect(res.body.timezone).toBe('Africa/Cairo');
      expect(res.body.countryCode).toBeNull();
    });

    it('a rejected pair changes NOTHING — the stored calendar survives the refusal', async () => {
      await patch({ countryCode: 'EG' });
      const before = await request(http).get(`${V}/settings`).set({ Authorization: `Bearer ${token}` });
      expect(before.body.timezone).toBe('Africa/Cairo');

      const refused = await patch({ countryCode: 'SA', timezone: 'Europe/London' });
      expect(refused.status).toBe(400);

      const after = await request(http).get(`${V}/settings`).set({ Authorization: `Bearer ${token}` });
      expect(after.body.countryCode).toBe('EG');
      expect(after.body.timezone).toBe('Africa/Cairo');
    });
  });

  // =========================================================================
  // 3. REGISTRATION — the family is created WITH its market
  // =========================================================================
  describe('3. registration creates the family with its country', () => {
    it("a registration naming 'SA' creates the family WITH it, and with the Saudi calendar", async () => {
      const reg = await register('reg-sa', { countryCode: 'SA' });
      expect(reg.status).toBe(201);

      const row = await familyRow(reg.body.familyId);
      // The assertion that matters: the column is set by the CREATE, not by a
      // follow-up PATCH the client might never send.
      expect(row.countryCode).toBe('SA');
      expect(row.timezone).toBe('Asia/Riyadh');
    });

    it('a registration with NO country still succeeds and leaves the column NULL', async () => {
      // Backward compatibility, stated as a test: every existing caller sends no
      // country, and none of them may break. NULL is kept rather than defaulted
      // — an invented 'EG' would be reported by the growth dashboard as measured
      // fact.
      const reg = await register('reg-none');
      expect(reg.status).toBe(201);

      const row = await familyRow(reg.body.familyId);
      expect(row.countryCode).toBeNull();
      expect(row.timezone).toBe('UTC');
    });

    it("a lowercase 'eg' at registration is normalised before it reaches the foreign key", async () => {
      const reg = await register('reg-eg-lower', { countryCode: 'eg' });
      expect(reg.status).toBe(201);

      const row = await familyRow(reg.body.familyId);
      expect(row.countryCode).toBe('EG');
      expect(row.timezone).toBe('Africa/Cairo');
    });

    it('an unsupported country at registration is a typed 400 and creates NO account', async () => {
      const reg = await register('reg-zz', { countryCode: 'ZZ' });
      expect(reg.status).toBe(400);
      assertB3Envelope(reg.body, 'COUNTRY_NOT_SUPPORTED');

      // THE ASSERTION THAT MATTERS. A refusal after the transaction would leave
      // a User and a Family behind — the same property the pilot gate is placed
      // before `createParentWithFamily` for.
      const user = await sys('look for the refused user', () =>
        prisma.user.findUnique({ where: { email: `f1.reg-zz.${stamp}@example.test` } }),
      );
      expect(user).toBeNull();
    });

    it('a registration whose country and timezone disagree is refused before anything is written', async () => {
      const reg = await register('reg-mismatch', {
        countryCode: 'SA',
        timezone: 'Africa/Cairo',
      });
      expect(reg.status).toBe(400);
      assertB3Envelope(reg.body, 'COUNTRY_TIMEZONE_MISMATCH');

      const user = await sys('look for the refused user', () =>
        prisma.user.findUnique({ where: { email: `f1.reg-mismatch.${stamp}@example.test` } }),
      );
      expect(user).toBeNull();
    });

    it('a registration sending the correct pair is accepted', async () => {
      const reg = await register('reg-pair', { countryCode: 'EG', timezone: 'Africa/Cairo' });
      expect(reg.status).toBe(201);
      const row = await familyRow(reg.body.familyId);
      expect(row.countryCode).toBe('EG');
      expect(row.timezone).toBe('Africa/Cairo');
    });
  });

  // =========================================================================
  // 4. ANALYTICS — "registered families in SA" against real rows
  // =========================================================================
  describe('4. the analytics predicate attributes families to markets, executed', () => {
    let saFamily = '';
    let egFamilyWithSaLabel = '';
    let unattributableFamily = '';
    let labelOnlyFamily = '';

    beforeAll(async () => {
      const mk = async (label: string, countryCode: string | null): Promise<string> => {
        const family = await sys('seed family', () =>
          prisma.family.create({
            data: { name: `f1 ${label} ${stamp}`, timezone: 'UTC', countryCode: countryCode ?? undefined },
            select: { id: true },
          }),
        );
        createdFamilies.push(family.id);
        return family.id;
      };

      // (a) the server knows it is Saudi.
      saFamily = await mk('sa', 'SA');

      // (b) the server says EG; the untrusted marketing label says SA. This is
      //     the case the precedence exists for.
      egFamilyWithSaLabel = await mk('eg-with-sa-label', 'EG');
      await sys('seed contradicting label', () =>
        prisma.acquisitionAttribution.create({
          data: { familyId: egFamilyWithSaLabel, channel: 'TIKTOK', countryCode: 'SA' },
        }),
      );

      // (c) a pre-F1 household: no country of its own, but an ad label.
      labelOnlyFamily = await mk('label-only', null);
      await sys('seed label', () =>
        prisma.acquisitionAttribution.create({
          data: { familyId: labelOnlyFamily, channel: 'ORGANIC', countryCode: 'SA' },
        }),
      );

      // (d) no country anywhere. NOT attributable.
      unattributableFamily = await mk('unattributable', null);
    }, 120_000);

    /** Counts within THIS suite's fixtures only, so other rows cannot move it. */
    const countIn = (countryCode: string, ids: string[]): Promise<number> =>
      sys('count by market', () =>
        prisma.family.count({ where: { id: { in: ids }, ...familyCountryWhere(countryCode) } }),
      );

    it('«registered families in SA» is a real number, and it counts the family the SERVER recorded', async () => {
      const ids = [saFamily, egFamilyWithSaLabel, labelOnlyFamily, unattributableFamily];
      const sa = await countIn('SA', ids);
      // saFamily (own country) + labelOnlyFamily (NULL own country, label SA).
      // NOT egFamilyWithSaLabel: its own country is EG and that decides.
      expect(sa).toBe(2);
    });

    it("THE SERVER'S RECORD OUTRANKS THE CLIENT'S LABEL: an EG family with an SA ad label counts as EG", async () => {
      const ids = [egFamilyWithSaLabel];
      expect(await countIn('EG', ids)).toBe(1);
      expect(await countIn('SA', ids)).toBe(0);
    });

    it('THE MARKETS ARE DISJOINT: no family is counted twice, so the parts cannot exceed the whole', async () => {
      const ids = [saFamily, egFamilyWithSaLabel, labelOnlyFamily, unattributableFamily];
      const eg = await countIn('EG', ids);
      const sa = await countIn('SA', ids);
      const platform = await sys('count platform', () =>
        prisma.family.count({ where: { id: { in: ids }, ...familyCountryWhere(PLATFORM_SCOPE) } }),
      );

      expect(platform).toBe(4);
      // 1 EG + 2 SA = 3 attributable, and the difference is exactly the one
      // household nothing knows the market of. That difference is how the
      // unattributable population stays OBSERVABLE without inventing a KPI for
      // it: platform minus the sum of the countries.
      expect(eg + sa).toBe(3);
      expect(platform - (eg + sa)).toBe(1);
    });

    it('A NULL-COUNTRY FAMILY IS NOT SILENTLY FOLDED INTO A MARKET', async () => {
      const ids = [unattributableFamily];
      expect(await countIn('EG', ids)).toBe(0);
      expect(await countIn('SA', ids)).toBe(0);
    });

    it('...AND IT IS NOT SILENTLY DROPPED FROM THE PLATFORM TOTAL EITHER', async () => {
      // It is a real household. Excluding it from every per-country number is
      // honesty; excluding it from the platform number too would be an
      // undercount nobody could see.
      const platform = await sys('count platform', () =>
        prisma.family.count({
          where: { id: { in: [unattributableFamily] }, ...familyCountryWhere(PLATFORM_SCOPE) },
        }),
      );
      expect(platform).toBe(1);
    });

    it('a family that set its country through PATCH /settings becomes attributable from that moment', async () => {
      // The loop closed: the settings write is what makes the growth number move,
      // which is the entire chain F1 exists to connect.
      const reg = await register('analytics-loop');
      expect(reg.status).toBe(201);
      const token = await tokenFor('analytics-loop');
      const id = reg.body.familyId;

      expect(await countIn('SA', [id])).toBe(0);

      const patched = await request(http)
        .patch(`${V}/settings`)
        .set({ Authorization: `Bearer ${token}` })
        .send({ countryCode: 'SA' });
      expect(patched.status).toBe(200);

      expect(await countIn('SA', [id])).toBe(1);
      expect(await countIn('EG', [id])).toBe(0);
    });
  });
});
