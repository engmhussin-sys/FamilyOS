import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';

import { runAsSystem } from './system-context';
import { SYSTEM_ROUTE_METADATA, type SystemRouteMetadata } from './system-route.decorator';
import { runWithContext, type TenantActorType, type TenantContext } from './tenant-context';

/**
 * Binds the tenant to the request's async execution context.
 *
 * CONTEXT.md principle 3 is enforced here by omission: this file reads
 * `request.user` and NOTHING else. `request.body`, `request.query`,
 * `request.params` and `request.headers` are never consulted, so a client
 * cannot name the tenant it wants to be — it can only prove which one it is.
 * `request.user` is produced by Passport from a signature-verified JWT
 * (`jwt.strategy.ts` / `device-jwt.strategy.ts`), for both parent and device
 * tokens; both carry `familyId`.
 *
 * Registered globally (APP_INTERCEPTOR) so a newly added controller is covered
 * without anyone remembering to opt in. Requests with neither an authenticated
 * principal nor an explicit `@SystemRoute` get NO context at all — which makes
 * every tenant-scoped query on that request throw. That is deliberate.
 */
@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(execCtx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (execCtx.getType() !== 'http') return next.handle();

    const request = execCtx.switchToHttp().getRequest();
    const principal = request?.user as
      | { sub?: string; familyId?: string; actorType?: TenantActorType }
      | undefined;

    if (principal?.familyId && principal.sub) {
      const ctx: TenantContext = {
        kind: 'TENANT',
        familyId: principal.familyId,
        actorType: principal.actorType === 'DEVICE' ? 'DEVICE' : 'USER',
        actorId: principal.sub,
        requestId: request?.correlationId,
      };
      return new Observable((subscriber) =>
        runWithContext(ctx, () => next.handle().subscribe(subscriber)),
      );
    }

    const systemRoute = this.reflector.getAllAndOverride<SystemRouteMetadata | undefined>(
      SYSTEM_ROUTE_METADATA,
      [execCtx.getHandler(), execCtx.getClass()],
    );

    if (systemRoute) {
      return new Observable((subscriber) =>
        runAsSystem(systemRoute.reason, systemRoute.justification, () =>
          next.handle().subscribe(subscriber),
        ),
      );
    }

    // No tenant, no declared system purpose: run with no ambient context. Any
    // tenant-scoped Prisma call on this request now throws instead of silently
    // returning every family's rows.
    return next.handle();
  }
}
