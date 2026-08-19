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

  // --- THE OPERATOR KEY IS COMPARED IN CONSTANT TIME -------------------------

  /**
   * `providedKey !== expectedKey` short-circuits at the first differing byte,
   * so the time the guard takes to say no is a function of how many leading
   * bytes the caller guessed right. On an endpoint an attacker may call as
   * often as they like that is a byte-at-a-time oracle: the operator key falls
   * in O(alphabet × length) requests instead of O(alphabet ^ length).
   *
   * WHY THIS IS ASSERTED STRUCTURALLY RATHER THAN BY MEASURING A CLOCK. A
   * timing assertion in a unit test measures the machine, the scheduler and the
   * JIT far more than it measures the comparison; it would be flaky in CI and
   * would prove nothing on a quiet machine. What CAN be decided exactly is
   * whether the code still contains the short-circuiting comparison, and the
   * length-based early return that is the usual "fix" for it — so that is what
   * is decided, over the real source file, alongside the behaviour below.
   */
  describe('the operator key comparison', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('path');
    const GUARD_PATH = path.resolve(__dirname, '../../src/common/guards/internal-admin.guard.ts');
    /** Comments stripped: a docstring that MENTIONS `!==` is not a comparison. */
    const CODE: string = fs
      .readFileSync(GUARD_PATH, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');

    it('goes through crypto.timingSafeEqual, not a short-circuiting string compare', () => {
      expect(CODE).toContain('timingSafeEqual');
      // The exact defect: the provided key compared with the expected key by an
      // operator that returns as soon as two bytes differ.
      expect(CODE).not.toMatch(/providedKey\s*[!=]==\s*expectedKey/);
      expect(CODE).not.toMatch(/expectedKey\s*[!=]==\s*providedKey/);
    });

    it('has no length-based early return — the length of the real key must not be observable either', () => {
      // `timingSafeEqual` throws on unequal lengths, and the obvious guard for
      // that (`if (a.length !== b.length) return false`) puts the early return
      // straight back, this time leaking how long the secret is.
      expect(CODE).not.toMatch(/\.length\s*[!=]==\s*\w*(?:[Kk]ey|candidate|expected|provided)/);
      expect(CODE).not.toMatch(/(?:[Kk]ey|candidate|expected|provided)\w*\.length\s*[!=]==/);
    });

    it('still denies every wrong key, including ones that share a prefix or differ in length', () => {
      process.env.INTERNAL_ADMIN_API_KEY = 'real-secret-value';

      for (const wrong of [
        '', // empty
        'r', // one correct byte
        'real-secret-valu', // every byte but the last
        'real-secret-value-and-then-some', // the whole key as a prefix, longer
        'real-secret-valuE', // one byte off, at the end
        'x'.repeat(4096), // far longer than the secret
      ]) {
        expect(() => guard.canActivate(buildContext(wrong))).toThrow(UnauthorizedException);
      }
    });

    it('a REPEATED x-internal-admin-key header (an array, not a string) is denied, not coerced', () => {
      process.env.INTERNAL_ADMIN_API_KEY = 'real-secret-value';
      const context = {
        switchToHttp: () => ({
          getRequest: () => ({
            headers: { 'x-internal-admin-key': ['real-secret-value', 'real-secret-value'] },
          }),
        }),
        getHandler: () => platformAdminRoute,
        getClass: () => class FakeController {},
      } as unknown as ExecutionContext;

      expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
    });

    it('and the correct key is still accepted — the fix did not lock the operator out', () => {
      process.env.INTERNAL_ADMIN_API_KEY = 'real-secret-value';
      expect(guard.canActivate(buildContext('real-secret-value'))).toBe(true);
    });
  });
});
