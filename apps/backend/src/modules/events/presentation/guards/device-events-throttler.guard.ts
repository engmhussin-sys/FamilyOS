import { Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
  ThrottlerStorage,
  type ThrottlerModuleOptions,
} from '@nestjs/throttler';

/**
 * `@nestjs/throttler` does not export `THROTTLER_SKIP` from its public entry
 * point (only from `dist/throttler.constants`), so it is restated here rather
 * than imported across a private path that a minor release could move.
 *
 * The copy is not trusted on faith: `test/events/device-throttler.spec.ts`
 * applies the real `@SkipThrottle()` decorator to a probe handler and asserts
 * that the metadata it writes starts with THIS string. If a future upgrade
 * renames the key, that test goes red — instead of the rate limit silently
 * switching itself off again.
 */
export const THROTTLER_SKIP_METADATA_PREFIX = 'THROTTLER:SKIP';

/**
 * A `Reflector` that is blind to `@SkipThrottle()`, and to nothing else.
 *
 * THE BUG THIS EXISTS TO FIX, caught by `test/events/event-pipeline.e2e.spec.ts`
 * and written down because the code that had it looked entirely correct:
 *
 *   `@SkipThrottle()` does NOT work by making `ThrottlerGuard.shouldSkip()`
 *   return true. It writes `THROTTLER:SKIP<name>` metadata, and `canActivate`
 *   reads that metadata SEPARATELY, per named throttler, AFTER `shouldSkip()`
 *   has already returned false. A subclass that only overrides `shouldSkip()`
 *   — the obvious way to write this — is therefore still skipped in full. The
 *   per-device limit was not "loose", it was ABSENT: every request passed. A
 *   rate limit that silently does nothing is worse than none, because it is
 *   believed.
 *
 * Rather than reimplement `canActivate` (which would then have to be re-checked
 * on every `@nestjs/throttler` upgrade), this guard is given its own Reflector
 * that answers `false` for exactly the skip key. Everything else — `@Throttle`'s
 * limit and ttl, the storage, the headers, the exception — is the library's,
 * untouched. The instance is private to this guard, so nothing else in the
 * application ever sees a modified Reflector.
 */
class SkipBlindReflector extends Reflector {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  getAllAndOverride<TResult = any, TKey = any>(metadataKey: TKey, targets: any[]): TResult {
    if (typeof metadataKey === 'string' && metadataKey.startsWith(THROTTLER_SKIP_METADATA_PREFIX)) {
      return false as unknown as TResult;
    }
    return super.getAllAndOverride<TResult, TKey>(metadataKey, targets);
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/**
 * docs/06 §9.1, category `EVENTS`: **12 batches per hour, keyed by `deviceId`**.
 *
 * The application-wide `ThrottlerGuard` (APP_GUARD in `app.module.ts`) keys on
 * IP, which is the wrong key here for a reason that matters in the target
 * markets: docs/06 §9.2 records that Egyptian mobile networks use CGNAT
 * heavily, so several families share one IP. An IP-keyed limit on the ingestion
 * endpoint would throttle a neighbour's child.
 *
 * HOW IT COMPOSES WITH THE GLOBAL GUARD, deliberately:
 *   the route carries `@SkipThrottle()`, which switches the GLOBAL IP-keyed
 *   guard off. That is not cosmetic: the route's own `@Throttle({ default: ...
 *   })` would otherwise ALSO reprogram the global guard to 12-per-hour PER IP,
 *   which is exactly the CGNAT failure above. This subclass then ignores that
 *   same skip flag (see `SkipBlindReflector`), so the route ends up with
 *   exactly one limit — the per-device one the spec asks for.
 *
 * Reuses `@nestjs/throttler` and its Redis storage (SA-004) wholesale. The only
 * things overridden are the tracker (the key was wrong) and the skip lookup
 * (the guard was being skipped entirely).
 */
@Injectable()
export class DeviceEventsThrottlerGuard extends ThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storageService: ThrottlerStorage,
  ) {
    super(options, storageService, new SkipBlindReflector());
  }

  protected async shouldSkip(): Promise<boolean> {
    return false;
  }

  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    // `req.user` is Passport's output from the VERIFIED device token, produced
    // by DeviceJwtAuthGuard, which runs before this guard. `sub` is the
    // deviceId. The IP fallback exists only for the impossible case of this
    // guard being reached without an authenticated device; it fails closed
    // (still limited) rather than open.
    const user = req.user as { sub?: string } | undefined;
    if (user?.sub) return `device:${user.sub}`;
    return `ip:${String(req.ip ?? 'unknown')}`;
  }
}
