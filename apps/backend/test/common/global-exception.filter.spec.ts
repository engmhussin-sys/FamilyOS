import { ArgumentsHost, ConflictException, NotFoundException } from '@nestjs/common';
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
