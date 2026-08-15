import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { AuditService } from '../../modules/audit/application/audit.service';
import { runWithTenant } from '../tenancy/tenant-context';
import { ResourceNotVisibleException } from './authz.errors';
import { resolveBreakGlass } from './route-authorizer';
import type { AuthorizedPrincipal } from './route-authorizer';

/**
 * Writes the audit row that makes a support read legitimate, BEFORE the
 * handler runs — so an unhandled exception inside the handler cannot swallow
 * the fact that the read was attempted.
 *
 * `familyId` comes from the verified token (never the body), and the write runs
 * inside an explicit `runWithTenant` because guards execute BEFORE the global
 * `TenantContextInterceptor`, so no ambient tenant exists yet at this point in
 * the pipeline. A1 (BA-009) found `AuditLog` had no `familyId` at all; F2 added
 * it; this row uses it, which is what makes the trail answerable to the
 * question "who looked at MY child's data".
 *
 * ZERO ROUTES USE THIS TODAY — there is no support console in this repository.
 * It is built, unit-tested, and enforced by the generated sweep so that the
 * first route that ever admits `Role.SUPPORT` cannot do so unaudited.
 */
@Injectable()
export class BreakGlassGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const meta = resolveBreakGlass(this.reflector, context);
    if (!meta) throw new ResourceNotVisibleException();
    if (!meta.justification?.trim()) throw new ResourceNotVisibleException();

    const request = context.switchToHttp().getRequest();
    const principal = request?.user as AuthorizedPrincipal | undefined;
    if (!principal?.familyId || !principal.sub) throw new ResourceNotVisibleException();

    await runWithTenant(
      { familyId: principal.familyId, actorType: 'USER', actorId: principal.sub },
      async () =>
        this.audit.record({
          actorType: 'USER',
          actorUserId: principal.sub,
          action: 'authz.break_glass.opened',
          entityType: 'Family',
          entityId: principal.familyId as string,
          metadata: {
            scope: meta.scope,
            justification: meta.justification,
            route: `${context.getClass()?.name}.${context.getHandler()?.name}`,
          },
          ipAddress: request?.ip,
        }),
    );

    return true;
  }
}
