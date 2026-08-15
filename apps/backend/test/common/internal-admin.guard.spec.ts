import {
  ExecutionContext,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { InternalAdminGuard } from '../../src/common/guards/internal-admin.guard';
import { ParentSurface, PlatformAdminSurface } from '../../src/common/authz/roles.decorator';

describe('InternalAdminGuard (critical business-metrics-exposure fix)', () => {
  const guard = new InternalAdminGuard(new Reflector());
  const originalEnv = process.env.INTERNAL_ADMIN_API_KEY;

  afterEach(() => {
    process.env.INTERNAL_ADMIN_API_KEY = originalEnv;
  });

  /**
   * PHASE C. The guard now also answers "does THIS route admit a SUPER_ADMIN?",
   * so the fake ExecutionContext has to carry a handler whose metadata a REAL
   * `Reflector` can read. `decorate()` applies the real decorator to a real
   * function — no hand-written metadata keys — so renaming the key cannot make
   * this suite pass vacuously.
   */
  function decorate(dec: MethodDecorator): () => void {
    const holder = {
      handler(): void {
        /* route body */
      },
    };
    dec(holder, 'handler', Object.getOwnPropertyDescriptor(holder, 'handler') as PropertyDescriptor);
    return holder.handler;
  }

  const platformAdminRoute = decorate(PlatformAdminSurface());
  const parentRoute = decorate(ParentSurface());
  const undeclaredRoute = (): void => undefined;

  function buildContext(
    headerValue?: string,
    handler: () => void = platformAdminRoute,
  ): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => ({ headers: { 'x-internal-admin-key': headerValue } }),
      }),
      getHandler: () => handler,
      getClass: () => class FakeController {},
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

  // --- PHASE C additions ---------------------------------------------------

  it('the CORRECT key is NOT enough on a route that does not admit SUPER_ADMIN — and answers 404, not 403', () => {
    process.env.INTERNAL_ADMIN_API_KEY = 'real-secret-value';

    // A platform operator poking a family route must not learn whether that
    // family exists, so the denial is indistinguishable from a missing route.
    expect(() => guard.canActivate(buildContext('real-secret-value', parentRoute))).toThrow(
      NotFoundException,
    );
  });

  it('a route behind this guard that declares NO roles is denied, not silently admitted', () => {
    process.env.INTERNAL_ADMIN_API_KEY = 'real-secret-value';

    expect(() => guard.canActivate(buildContext('real-secret-value', undeclaredRoute))).toThrow(
      ForbiddenException,
    );
  });
});
