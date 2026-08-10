import { ExecutionContext, UnauthorizedException } from '@nestjs/common';

import { InternalAdminGuard } from '../../src/common/guards/internal-admin.guard';

describe('InternalAdminGuard (critical business-metrics-exposure fix)', () => {
  const guard = new InternalAdminGuard();
  const originalEnv = process.env.INTERNAL_ADMIN_API_KEY;

  afterEach(() => {
    process.env.INTERNAL_ADMIN_API_KEY = originalEnv;
  });

  function buildContext(headerValue?: string): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => ({ headers: { 'x-internal-admin-key': headerValue } }),
      }),
    } as unknown as ExecutionContext;
  }

  it('FAILS CLOSED (denies) when INTERNAL_ADMIN_API_KEY is not set on the environment — the critical safety property', () => {
    delete process.env.INTERNAL_ADMIN_API_KEY;

    expect(() => guard.canActivate(buildContext('anything'))).toThrow(UnauthorizedException);
  });

  it('denies a request with no header at all', () => {
    process.env.INTERNAL_ADMIN_API_KEY = 'real-secret-value';

    expect(() => guard.canActivate(buildContext(undefined))).toThrow(UnauthorizedException);
  });

  it('denies a request with the WRONG key', () => {
    process.env.INTERNAL_ADMIN_API_KEY = 'real-secret-value';

    expect(() => guard.canActivate(buildContext('wrong-guess'))).toThrow(UnauthorizedException);
  });

  it('allows a request with the CORRECT key', () => {
    process.env.INTERNAL_ADMIN_API_KEY = 'real-secret-value';

    expect(guard.canActivate(buildContext('real-secret-value'))).toBe(true);
  });
});
