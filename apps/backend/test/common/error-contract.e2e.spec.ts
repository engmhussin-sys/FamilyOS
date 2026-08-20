/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * B3 — THE GLOBAL ERROR CONTRACT, ASSERTED OVER A REAL HTTP SOCKET.
 *
 * WHY THIS FILE HAD TO EXIST BEFORE THE FIX COULD BE CALLED DONE
 * -------------------------------------------------------------
 * PA-B-021 (`Runtime Tested`) proved production answered a child who had hit
 * her daily reward limit with `{"message":"Conflict Exception"}` — every Arabic
 * non-punitive sentence F4 wrote was unreachable. PA-B-022 explains why 45 e2e
 * assertions never noticed: `reward-engine.e2e.spec.ts:274-276` and
 * `event-pipeline.e2e.spec.ts:350-353` boot an app WITHOUT
 * `GlobalExceptionFilter`, WITHOUT `setGlobalPrefix('api/v1')` and with a
 * looser `ValidationPipe`. They were asserting Nest's DEFAULT error shape on
 * unprefixed URLs — a response no deployed client has ever received.
 *
 * So this suite does the one thing those could not: it installs the SAME
 * function `main.ts` calls (`applyGlobalHttpPipeline`) — not a copy of it, the
 * same function — and asserts what comes back off the wire. If someone ever
 * removes `code` or `messageAr` from the filter again, or drops the prefix, or
 * loosens the pipe, these tests go red before a child sees English.
 *
 * TWO HALVES, ON PURPOSE:
 *   A. THE REAL APPLICATION — `AppModule` itself, every real guard and route,
 *      with Prisma/Redis stubbed (the DI-graph technique from
 *      `app.module.spec.ts`). Proves the prefix and the 401/404 contract on
 *      routes that actually ship. Runs in the default (no-database) lane.
 *   B. A PROBE MODULE — the same pipeline, plus a controller that throws one
 *      representative exception per status. Provoking a real 409-with-Arabic
 *      or a real 500-from-a-Prisma-failure through the shipping routes would
 *      need a database AND a seeded family; the exceptions thrown below are
 *      copied verbatim from the call sites named in each test.
 */
import { Controller, Get, INestApplication, MiddlewareConsumer, Module, NestModule, Post, Body } from '@nestjs/common';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { IsInt, IsString, Min } from 'class-validator';
import request = require('supertest');

import { applyGlobalHttpPipeline } from '../../src/common/http/global-pipeline';
import { CorrelationIdMiddleware } from '../../src/common/middleware/correlation-id.middleware';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { RedisService } from '../../src/common/redis/redis.service';

jest.mock('@sentry/node', () => ({ captureException: jest.fn(), init: jest.fn() }));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Anything in a body matching one of these is a leak, whatever the status. */
const LEAK_MARKERS = [
  'at Object.', // a v8 stack frame
  'at Function.',
  '.ts:', // a source location
  'node_modules',
  'prisma',
  'Prisma',
  'SELECT ',
  'INSERT INTO',
  'UPDATE ',
  'postgresql://',
  'redis://',
  'hunter2',
  'sk_live_',
  'password',
  'DATABASE_URL',
];

function assertNoLeak(body: unknown): void {
  const json = JSON.stringify(body);
  for (const marker of LEAK_MARKERS) {
    expect(json).not.toContain(marker);
  }
}

/** Every error response, without exception, must satisfy this. */
function assertContractShape(body: any, status: number): void {
  expect(body.statusCode).toBe(status);
  expect(typeof body.code).toBe('string');
  expect(body.code.length).toBeGreaterThan(0);
  expect(body.message === undefined).toBe(false);
  expect(typeof body.messageAr).toBe('string');
  expect(body.messageAr.length).toBeGreaterThan(0);
  expect(typeof body.details).toBe('object');
  expect(body.details).not.toBeNull();
  expect(typeof body.requestId).toBe('string');
  expect(body.requestId.length).toBeGreaterThan(0);
  // Backward compatibility: the four fields shipped clients already read.
  expect(typeof body.correlationId).toBe('string');
  expect(typeof body.timestamp).toBe('string');
  expect(typeof body.path).toBe('string');
  assertNoLeak(body);
}

// ===========================================================================
// B. THE PROBE MODULE
// ===========================================================================

class ProbeDto {
  @IsString()
  name!: string;

  @IsInt()
  @Min(1)
  amount!: number;
}

@Controller('error-probe')
class ErrorProbeController {
  /** class-validator failure — the DTO path every controller shares. */
  @Post('validate')
  validate(@Body() dto: ProbeDto): ProbeDto {
    return dto;
  }

  /** reward-program.service.ts:73 — `{ code, errors }`, no prose at all. */
  @Get('spec-invalid')
  specInvalid(): never {
    throw new BadRequestException({
      code: 'TARGET_SPEC_INVALID',
      errors: [{ field: 'targetSpec.toAyah', code: 'AYAH_OUT_OF_SURAH', messageAr: 'رقم الآية خارج نطاق السورة.' }],
    });
  }

  @Get('unauthenticated')
  unauthenticated(): never {
    throw new UnauthorizedException();
  }

  /** achievement.service.ts:182 — `{ code, messageAr }`, the F4 shape. */
  @Get('not-yours')
  notYours(): never {
    throw new ForbiddenException({ code: 'NOT_YOUR_ACHIEVEMENT', messageAr: 'هذه ليست محاولتك.' });
  }

  /** organization.service.ts:74 — a legacy plain-string 403. */
  @Get('forbidden-legacy')
  forbiddenLegacy(): never {
    throw new ForbiddenException('You do not have permission to create a sub-organization here.');
  }

  /** achievement.service.ts:82 — `{ code, messageAr }` on a 404. */
  @Get('program-missing')
  programMissing(): never {
    throw new NotFoundException({ code: 'PROGRAM_NOT_FOUND', messageAr: 'البرنامج غير موجود.' });
  }

  /** habit-engine.service.ts:65 — a legacy plain-string 404. */
  @Get('habit-missing')
  habitMissing(): never {
    throw new NotFoundException('Habit not found');
  }

  /**
   * THE DEFECT ITSELF: `achievement.service.ts:113` throws the violation object
   * `program-rules.ts:87` returns. This is the exact exception that produced
   * `{"message":"Conflict Exception"}` in production.
   */
  @Get('daily-limit')
  dailyLimit(): never {
    throw new ConflictException({
      code: 'MAX_PER_DAY_REACHED',
      messageAr: 'أكملت هذا البرنامج 1 مرة اليوم — وهذا هو الحد اليومي. نراك غدًا!',
    });
  }

  /** event-ingestion.service.ts:169 — `{ code, message }`, English only. */
  @Get('batch-too-large')
  batchTooLarge(): never {
    throw new PayloadTooLargeException({
      code: 'EVENT_BATCH_TOO_LARGE',
      message: 'A batch may carry at most 100 events; received 240.',
    });
  }

  @Get('not-verified')
  notVerified(): never {
    throw new UnprocessableEntityException({ code: 'ACHIEVEMENT_NOT_VERIFIED' });
  }

  /** billing.errors.ts — an intentional, safe-to-expose 503. */
  @Get('provider-down')
  providerDown(): never {
    throw new ServiceUnavailableException('The Paymob payment provider is not configured.');
  }

  /** The 500 path: a raw error carrying exactly what must never be returned. */
  @Get('boom')
  boom(): never {
    throw new Error(
      'SELECT * FROM users WHERE password = $1 — connection postgresql://afdc:hunter2@10.0.0.4:5432/prod failed',
    );
  }

  /** A body that tries to smuggle a secret out through `details`. */
  @Get('smuggle')
  smuggle(): never {
    throw new BadRequestException({
      code: 'DEVICE_CLOCK_SKEW',
      message: 'Device clock differs from server clock by more than 10 minutes.',
      serverTime: '2026-08-15T09:00:00.000Z',
      accessToken: 'eyJhbGciOiJIUzI1NiJ9.secret',
      internalStack: new Error('boom'),
    });
  }
}

@Module({ controllers: [ErrorProbeController] })
class ErrorProbeModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}

describe('B3 — the global error contract, over a real HTTP socket', () => {
  let app: INestApplication;
  let http: any;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ErrorProbeModule] }).compile();
    app = moduleRef.createNestApplication();
    // THE POINT OF THE SUITE: the same function main.ts calls, not a copy.
    applyGlobalHttpPipeline(app);
    await app.init();
    http = app.getHttpServer();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  // -------------------------------------------------------------------
  // the regression that must never come back
  // -------------------------------------------------------------------
  describe('REGRESSION GUARD — PA-B-021', () => {
    it('a `{ code, messageAr }` ConflictException reaches the client WITH its code and its Arabic — not "Conflict Exception"', async () => {
      const res = await request(http).get('/api/v1/error-probe/daily-limit');

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('MAX_PER_DAY_REACHED');
      expect(res.body.messageAr).toBe('أكملت هذا البرنامج 1 مرة اليوم — وهذا هو الحد اليومي. نراك غدًا!');
      // The exact string production used to return, byte for byte.
      expect(res.body.message).not.toBe('Conflict Exception');
      expect(JSON.stringify(res.body)).not.toContain('Conflict Exception');
      assertContractShape(res.body, 409);
    });

    it('NO error response, at ANY status, may omit `code` or `messageAr`', async () => {
      const paths = [
        '/api/v1/error-probe/spec-invalid',
        '/api/v1/error-probe/unauthenticated',
        '/api/v1/error-probe/not-yours',
        '/api/v1/error-probe/forbidden-legacy',
        '/api/v1/error-probe/program-missing',
        '/api/v1/error-probe/habit-missing',
        '/api/v1/error-probe/daily-limit',
        '/api/v1/error-probe/batch-too-large',
        '/api/v1/error-probe/not-verified',
        '/api/v1/error-probe/provider-down',
        '/api/v1/error-probe/boom',
        '/api/v1/error-probe/smuggle',
        '/api/v1/no-such-route',
      ];

      for (const path of paths) {
        const res = await request(http).get(path);
        expect(res.status).toBeGreaterThanOrEqual(400);
        assertContractShape(res.body, res.status);
      }
    });

    it('the Arabic sentence survives JSON transport as real Arabic, not escaped mojibake', async () => {
      const res = await request(http).get('/api/v1/error-probe/program-missing');
      expect(res.headers['content-type']).toContain('application/json');
      expect(res.text).toContain('البرنامج'); // «البرنامج»
      expect(res.body.messageAr).toBe('البرنامج غير موجود.');
    });
  });

  // -------------------------------------------------------------------
  // one test per status the brief names
  // -------------------------------------------------------------------
  describe('400 — DTO validation (class-validator)', () => {
    it('shapes a class-validator failure as VALIDATION_FAILED with per-field details, keeping `message: string[]`', async () => {
      const res = await request(http).post('/api/v1/error-probe/validate').send({ amount: 0 });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect(res.body.messageAr).toBe('تعذّر قبول بعض الحقول المُرسلة. راجعها ثم أعد المحاولة.');
      // BACKWARD COMPATIBILITY: the admin dashboard joins this array
      // (`httpClient.ts:44`). It must still be an array of English sentences.
      expect(Array.isArray(res.body.message)).toBe(true);
      expect(res.body.message.join(' ')).toContain('name');
      // NEW: the per-field breakdown a form needs.
      const fields = res.body.details.fields.map((f: any) => f.field);
      expect(fields).toContain('name');
      expect(fields).toContain('amount');
      assertContractShape(res.body, 400);
    });

    it('`forbidNonWhitelisted` is really on — an unknown property is rejected, not silently stripped', async () => {
      const res = await request(http)
        .post('/api/v1/error-probe/validate')
        .send({ name: 'x', amount: 3, isAdmin: true });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect(JSON.stringify(res.body.message)).toContain('isAdmin');
    });
  });

  describe('400 — a domain code with no prose at all', () => {
    it('gives TARGET_SPEC_INVALID an Arabic sentence from the catalogue and keeps its `errors` in `details`', async () => {
      const res = await request(http).get('/api/v1/error-probe/spec-invalid');

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('TARGET_SPEC_INVALID');
      expect(res.body.messageAr).toBe('تفاصيل الهدف غير مكتملة أو غير صحيحة. راجعها ثم أعد الحفظ.');
      expect(res.body.details.errors[0].code).toBe('AYAH_OUT_OF_SURAH');
      assertContractShape(res.body, 400);
    });
  });

  describe('401', () => {
    it('UNAUTHENTICATED, with a non-punitive Arabic sentence', async () => {
      const res = await request(http).get('/api/v1/error-probe/unauthenticated');

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('UNAUTHENTICATED');
      expect(res.body.messageAr).toBe('انتهت جلستك. سجّل الدخول مرة أخرى للمتابعة.');
      assertContractShape(res.body, 401);
    });
  });

  describe('403', () => {
    it('carries the thrown domain code and Arabic when the call site provides them', async () => {
      const res = await request(http).get('/api/v1/error-probe/not-yours');

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('NOT_YOUR_ACHIEVEMENT');
      expect(res.body.messageAr).toBe('هذه ليست محاولتك.');
      assertContractShape(res.body, 403);
    });

    it('falls back to UNAUTHORIZED_ACTION for the 58 legacy plain-string throws, WITHOUT losing the English message', async () => {
      const res = await request(http).get('/api/v1/error-probe/forbidden-legacy');

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('UNAUTHORIZED_ACTION');
      expect(res.body.messageAr).toBe('ليس لديك صلاحية لتنفيذ هذا الإجراء.');
      // BACKWARD COMPATIBILITY: the English sentence is untouched.
      expect(res.body.message).toBe('You do not have permission to create a sub-organization here.');
      assertContractShape(res.body, 403);
    });
  });

  describe('404', () => {
    it('carries PROGRAM_NOT_FOUND and its Arabic', async () => {
      const res = await request(http).get('/api/v1/error-probe/program-missing');

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('PROGRAM_NOT_FOUND');
      expect(res.body.messageAr).toBe('البرنامج غير موجود.');
      // Nest derives "Not Found Exception" from the class name for an object
      // body — the same family of string as "Conflict Exception". It must not
      // reach the client either.
      expect(res.body.message).toBe('The requested resource was not found.');
      expect(JSON.stringify(res.body)).not.toContain('Exception');
      assertContractShape(res.body, 404);
    });

    it('a legacy plain-string 404 keeps its English and gains NOT_FOUND + Arabic', async () => {
      const res = await request(http).get('/api/v1/error-probe/habit-missing');

      expect(res.body.code).toBe('NOT_FOUND');
      expect(res.body.message).toBe('Habit not found');
      expect(res.body.messageAr).toBe('لم نجد ما تبحث عنه.');
      assertContractShape(res.body, 404);
    });

    it('an unrouted URL is shaped by the contract too — Nest’s own 404 does not escape the filter', async () => {
      const res = await request(http).get('/api/v1/definitely-not-a-route');

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
      expect(res.body.messageAr).toBe('لم نجد ما تبحث عنه.');
      assertContractShape(res.body, 404);
    });
  });

  describe('409', () => {
    it('is the daily-limit case above, and its Arabic is non-punitive — no «ممنوع», no «تجاوزت»', async () => {
      const res = await request(http).get('/api/v1/error-probe/daily-limit');

      expect(res.body.messageAr).not.toContain('ممنوع');
      expect(res.body.messageAr).not.toContain('تجاوزت');
      expect(res.body.messageAr).not.toContain('محظور');
      expect(res.body.messageAr).toContain('نراك غدًا');
    });
  });

  describe('413', () => {
    it('EVENT_BATCH_TOO_LARGE keeps its English `message` and gains Arabic from the catalogue', async () => {
      const res = await request(http).get('/api/v1/error-probe/batch-too-large');

      expect(res.status).toBe(413);
      expect(res.body.code).toBe('EVENT_BATCH_TOO_LARGE');
      expect(res.body.message).toContain('at most 100 events');
      expect(res.body.messageAr).toBe('عدد الأحداث في هذه الدفعة أكبر من المسموح. سنرسلها على دفعات أصغر.');
      assertContractShape(res.body, 413);
    });
  });

  describe('422', () => {
    it('ACHIEVEMENT_NOT_VERIFIED resolves both its English and its Arabic from the catalogue', async () => {
      const res = await request(http).get('/api/v1/error-probe/not-verified');

      expect(res.status).toBe(422);
      expect(res.body.code).toBe('ACHIEVEMENT_NOT_VERIFIED');
      expect(res.body.messageAr).toBe('لم يتم التحقق من الإنجاز بعد.');
      expect(res.body.message).toBe('This achievement has not been verified yet.');
      assertContractShape(res.body, 422);
    });
  });

  describe('500 — and what must never be in it', () => {
    it('returns the generic contract and leaks NO stack, NO SQL, NO connection string, NO password', async () => {
      const res = await request(http).get('/api/v1/error-probe/boom');

      expect(res.status).toBe(500);
      expect(res.body.code).toBe('INTERNAL_ERROR');
      expect(res.body.messageAr).toBe('حدث خطأ غير متوقّع عندنا. حاول مرة أخرى، وإن تكرّر أرسل لنا رقم الطلب.');

      const json = JSON.stringify(res.body);
      expect(json).not.toContain('SELECT');
      expect(json).not.toContain('hunter2');
      expect(json).not.toContain('postgresql://');
      expect(json).not.toContain('password');
      expect(json).not.toContain('at ErrorProbeController');
      expect(res.body.stack).toBeUndefined();
      // `details` is ALWAYS empty on a 5xx: there is nothing about a server
      // fault a client needs beyond the requestId.
      expect(res.body.details).toEqual({});
      assertContractShape(res.body, 500);
    });

    it('still hands the client a requestId it can quote to support', async () => {
      const res = await request(http).get('/api/v1/error-probe/boom');
      expect(res.body.requestId).toMatch(UUID_RE);
    });
  });

  describe('503 — an intentional, reviewed message survives untouched', () => {
    it('keeps the provider sentence and adds SERVICE_UNAVAILABLE + Arabic', async () => {
      const res = await request(http).get('/api/v1/error-probe/provider-down');

      expect(res.status).toBe(503);
      expect(res.body.code).toBe('SERVICE_UNAVAILABLE');
      expect(res.body.message).toBe('The Paymob payment provider is not configured.');
      expect(res.body.messageAr).toBe('الخدمة غير متاحة مؤقتًا. حاول بعد قليل.');
      assertContractShape(res.body, 503);
    });
  });

  // -------------------------------------------------------------------
  // `details` is not a hole
  // -------------------------------------------------------------------
  describe('`details` hardening', () => {
    it('keeps the useful key, drops the secret-looking key, and drops the nested Error entirely', async () => {
      const res = await request(http).get('/api/v1/error-probe/smuggle');

      expect(res.body.code).toBe('DEVICE_CLOCK_SKEW');
      expect(res.body.details.serverTime).toBe('2026-08-15T09:00:00.000Z');
      expect(res.body.details.accessToken).toBeUndefined();
      expect(res.body.details.internalStack).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toContain('eyJhbGciOiJIUzI1NiJ9');
      assertContractShape(res.body, 400);
    });

    it('a legacy plain-string exception contributes NOTHING to `details` — no unreviewed key can appear', async () => {
      const res = await request(http).get('/api/v1/error-probe/habit-missing');
      expect(res.body.details).toEqual({});
    });
  });

  // -------------------------------------------------------------------
  // requestId ↔ correlationId
  // -------------------------------------------------------------------
  describe('requestId correlates with the log entry and with F3’s traceId', () => {
    it('is the SAME value as correlationId and as the X-Correlation-Id response header — one id, not two', async () => {
      const res = await request(http).get('/api/v1/error-probe/program-missing');

      expect(res.body.requestId).toBe(res.body.correlationId);
      expect(res.body.requestId).toBe(res.headers['x-correlation-id']);
      expect(res.body.requestId).toMatch(UUID_RE);
    });

    it('honours an inbound X-Correlation-Id so a request already traced upstream keeps its id', async () => {
      const res = await request(http)
        .get('/api/v1/error-probe/daily-limit')
        .set('X-Correlation-Id', 'upstream-trace-42');

      expect(res.body.requestId).toBe('upstream-trace-42');
      expect(res.body.correlationId).toBe('upstream-trace-42');
    });

    it('two requests get two different ids — the id is per-request, not per-process', async () => {
      const a = await request(http).get('/api/v1/error-probe/boom');
      const b = await request(http).get('/api/v1/error-probe/boom');
      expect(a.body.requestId).not.toBe(b.body.requestId);
    });
  });

  // -------------------------------------------------------------------
  // the prefix — the other half of PA-B-022
  // -------------------------------------------------------------------
  describe('the api/v1 prefix is really installed', () => {
    it('the unprefixed path does NOT resolve — proving these assertions run on the deployed URL space', async () => {
      const prefixed = await request(http).get('/api/v1/error-probe/program-missing');
      const bare = await request(http).get('/error-probe/program-missing');

      expect(prefixed.body.code).toBe('PROGRAM_NOT_FOUND');
      expect(bare.status).toBe(404);
      expect(bare.body.code).toBe('NOT_FOUND');
      expect(bare.body.path).toBe('/error-probe/program-missing');
    });
  });
});

// ===========================================================================
// A. THE REAL APPLICATION
// ===========================================================================

describe('B3 — the contract on the REAL AppModule (every real guard, every real route)', () => {
  let app: INestApplication;
  let http: any;

  beforeAll(async () => {
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.JWT_ACCESS_SECRET = 'a'.repeat(32);
    process.env.JWT_REFRESH_SECRET = 'b'.repeat(32);

    const { AppModule } = await import('../../src/app.module');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue({ onModuleInit: jest.fn(), onModuleDestroy: jest.fn() })
      .overrideProvider(RedisService)
      .useValue({
        setWithTtl: jest.fn(),
        get: jest.fn(),
        getAndDelete: jest.fn(),
        increment: jest.fn().mockResolvedValue(1),
      })
      .compile();

    app = moduleRef.createNestApplication();
    applyGlobalHttpPipeline(app);
    await app.init();
    http = app.getHttpServer();
  }, 60000);

  afterAll(async () => {
    if (app) await app.close();
  });

  it('a real protected route, called with no token, answers the full contract — code + Arabic + requestId', async () => {
    const res = await request(http).get('/api/v1/children');

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHENTICATED');
    expect(res.body.messageAr).toBe('انتهت جلستك. سجّل الدخول مرة أخرى للمتابعة.');
    expect(typeof res.body.requestId).toBe('string');
    assertNoLeak(res.body);
  });

  it('the SAME real route without the api/v1 prefix is a 404 — the deployed URL space is what was just asserted', async () => {
    const res = await request(http).get('/children');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('a real 404 on a real prefixed-but-unknown route is shaped by the contract', async () => {
    const res = await request(http).get('/api/v1/children/does/not/exist/at/all');
    expect(res.status).toBe(404);
    expect(typeof res.body.messageAr).toBe('string');
    expect(res.body.messageAr.length).toBeGreaterThan(0);
    assertNoLeak(res.body);
  });

  it('the health probes stay OUTSIDE the prefix — infrastructure does not know about api/v1', async () => {
    const res = await request(http).get('/health/live');
    expect(res.status).toBe(200);
  });
});
