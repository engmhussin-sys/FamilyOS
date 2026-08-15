import {
  ArgumentsHost,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import * as Sentry from '@sentry/node';
import { GlobalExceptionFilter } from '../../src/common/filters/global-exception.filter';

jest.mock('@sentry/node', () => ({ captureException: jest.fn() }));

describe('GlobalExceptionFilter', () => {
  beforeEach(() => jest.clearAllMocks());

  function buildHost(correlationId = 'test-correlation-id') {
    const res: any = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    const req = { method: 'GET', url: '/api/v1/test', correlationId };

    const host = {
      switchToHttp: () => ({
        getResponse: () => res,
        getRequest: () => req,
      }),
    } as unknown as ArgumentsHost;

    return { host, res };
  }

  it('passes through a known HttpException\'s real message and status', () => {
    const filter = new GlobalExceptionFilter();
    const { host, res } = buildHost();

    filter.catch(new NotFoundException('Child not found.'), host);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 404, message: 'Child not found.' }),
    );
  });

  it('NEVER leaks the raw message of an unrecognized error — generic message only', () => {
    const filter = new GlobalExceptionFilter();
    const { host, res } = buildHost();

    filter.catch(new Error('SECRET: database password is hunter2'), host);

    expect(res.status).toHaveBeenCalledWith(500);
    const jsonArg = res.json.mock.calls[0][0];
    expect(jsonArg.message).not.toContain('hunter2');
    expect(jsonArg.message).not.toContain('SECRET');
  });

  it('every error response includes the correlationId for client-side reporting', () => {
    const filter = new GlobalExceptionFilter();
    const { host, res } = buildHost('abc-123');

    filter.catch(new ConflictException('Duplicate.'), host);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ correlationId: 'abc-123' }));
  });

  it('includes a timestamp and the request path in every response', () => {
    const filter = new GlobalExceptionFilter();
    const { host, res } = buildHost();

    filter.catch(new NotFoundException(), host);

    const jsonArg = res.json.mock.calls[0][0];
    expect(jsonArg.path).toBe('/api/v1/test');
    expect(typeof jsonArg.timestamp).toBe('string');
  });

  it('defaults correlationId to "unknown" if the middleware never ran', () => {
    const filter = new GlobalExceptionFilter();
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    const req = { method: 'GET', url: '/x' }; // no correlationId attached
    const host = {
      switchToHttp: () => ({ getResponse: () => res, getRequest: () => req }),
    } as unknown as ArgumentsHost;

    filter.catch(new NotFoundException(), host);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ correlationId: 'unknown' }));
  });

  /**
   * B3 / PA-B-021. These are the assertions whose absence let the defect ship:
   * the filter used to test `'message' in body`, find none on a
   * `{ code, messageAr }` body, and fall back to `exception.message` — which
   * Nest derives from the class name. `Runtime Tested` capture of the old
   * behaviour, at commit f2e537f:
   *
   *   GET /api/v1/error-probe/daily-limit -> 409
   *   {"statusCode":409,"message":"Conflict Exception","correlationId":"unknown",…}
   *
   * If any of these go red, that response is back.
   */
  describe('B3 — REGRESSION GUARD: `code` and `messageAr` must reach the client', () => {
    it('never drops `code` from a `{ code, messageAr }` body', () => {
      const filter = new GlobalExceptionFilter();
      const { host, res } = buildHost();

      filter.catch(
        new ConflictException({ code: 'MAX_PER_DAY_REACHED', messageAr: 'أكملت هذا البرنامج مرة اليوم.' }),
        host,
      );

      expect(res.json.mock.calls[0][0].code).toBe('MAX_PER_DAY_REACHED');
    });

    it('never drops `messageAr` from a `{ code, messageAr }` body', () => {
      const filter = new GlobalExceptionFilter();
      const { host, res } = buildHost();

      filter.catch(
        new ConflictException({ code: 'MAX_PER_DAY_REACHED', messageAr: 'أكملت هذا البرنامج مرة اليوم.' }),
        host,
      );

      expect(res.json.mock.calls[0][0].messageAr).toBe('أكملت هذا البرنامج مرة اليوم.');
    });

    it('NEVER returns Nest’s class-derived "Conflict Exception" as the message', () => {
      const filter = new GlobalExceptionFilter();
      const { host, res } = buildHost();

      filter.catch(new ConflictException({ code: 'ATTEMPT_ALREADY_OPEN', messageAr: 'لديك محاولة مفتوحة.' }), host);

      const body = res.json.mock.calls[0][0];
      expect(body.message).not.toBe('Conflict Exception');
      expect(JSON.stringify(body)).not.toContain('Conflict Exception');
    });

    it('emits `code` and a non-empty `messageAr` for EVERY exception class, including ones that carry neither', () => {
      const filter = new GlobalExceptionFilter();
      const cases: unknown[] = [
        new BadRequestException('limitMinutes is required when ruleType is TIME_LIMIT'),
        new NotFoundException(),
        new ForbiddenException('You do not have permission to invite members to this organization.'),
        new ConflictException({ code: 'PROGRAM_EXPIRED', messageAr: 'انتهت مدة هذا البرنامج.' }),
        new Error('anything at all'),
        'a thrown string',
      ];

      for (const thrown of cases) {
        const { host, res } = buildHost();
        filter.catch(thrown, host);
        const body = res.json.mock.calls[0][0];
        expect(typeof body.code).toBe('string');
        expect(body.code.length).toBeGreaterThan(0);
        expect(typeof body.messageAr).toBe('string');
        expect(body.messageAr.length).toBeGreaterThan(0);
      }
    });

    it('`requestId` is the SAME value as `correlationId` — one id, correlating with the log line', () => {
      const filter = new GlobalExceptionFilter();
      const { host, res } = buildHost('trace-777');

      filter.catch(new NotFoundException(), host);

      const body = res.json.mock.calls[0][0];
      expect(body.requestId).toBe('trace-777');
      expect(body.requestId).toBe(body.correlationId);
    });

    it('a 500 carries no stack, no raw message and an empty `details`', () => {
      const filter = new GlobalExceptionFilter();
      const { host, res } = buildHost();

      filter.catch(new Error('SELECT * FROM users; password=hunter2'), host);

      const body = res.json.mock.calls[0][0];
      expect(body.code).toBe('INTERNAL_ERROR');
      expect(body.details).toEqual({});
      expect(body.stack).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain('hunter2');
      expect(JSON.stringify(body)).not.toContain('SELECT');
    });
  });

  describe('Sentry reporting (Sprint 4 — Observability)', () => {
    it('reports an unrecognized (500-class) error to Sentry, tagged with the correlationId', () => {
      const filter = new GlobalExceptionFilter();
      const { host } = buildHost('abc-123');
      const error = new Error('Unexpected failure');

      filter.catch(error, host);

      expect(Sentry.captureException).toHaveBeenCalledWith(error, { tags: { correlationId: 'abc-123' } });
    });

    it('does NOT report an expected 4xx HttpException to Sentry \u2014 same condition as local error-level logging, not a broader one', () => {
      const filter = new GlobalExceptionFilter();
      const { host } = buildHost();

      filter.catch(new NotFoundException('Child not found.'), host);
      filter.catch(new ConflictException('Duplicate.'), host);

      expect(Sentry.captureException).not.toHaveBeenCalled();
    });
  });
});
