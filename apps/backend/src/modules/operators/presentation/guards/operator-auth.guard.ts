import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { InternalAdminGuard } from '../../../../common/guards/internal-admin.guard';
import { roleHasPermission, type Permission } from '../../../../common/authz/permissions';
import { OperatorSessionService, type OperatorSession } from '../../application/operator-session.service';
import { REQUIRED_PERMISSION_METADATA } from '../decorators/require-permission.decorator';

/**
 * ===========================================================================
 * TWO GATES IN SERIES, AND THE SECOND ONE HAS A NAME.
 * ===========================================================================
 *
 *   GATE 1 — `InternalAdminGuard`, unchanged, delegated to rather than
 *   reimplemented. It answers «did this request reach the console at all»
 *   using the shared platform key, in constant time, failing closed when the
 *   key is unset. Not deleted, and not weakened: it is the reason a scan of the
 *   public internet finds nothing here.
 *
 *   GATE 2 — this class. It answers «WHO is this, and MAY THEY do this
 *   specific thing». The shared key can no longer answer either question, and
 *   pretending it could was the defect.
 *
 * ── WHY IT DELEGATES INSTEAD OF COPYING ────────────────────────────────
 *
 * `InternalAdminGuard` contains a constant-time comparison, a length-blinding
 * step and a deliberate refusal to populate `request.user`. Reimplementing any
 * of that here would create a second copy that drifts; a route protected by the
 * copy would be protected by whichever version someone last remembered to fix.
 *
 * ── EVERY REFUSAL LOOKS THE SAME FROM OUTSIDE ──────────────────────────
 *
 * Missing session, malformed session, expired session, revoked operator and
 * insufficient permission all produce ONE 401 with one message. An attacker
 * learning «the session was valid but the permission was not» learns that the
 * session was valid, which is the single most useful thing they could be told.
 * The distinction is kept in the logs, where it belongs.
 *
 * ── IT FAILS CLOSED ON A ROUTE THAT FORGOT TO DECLARE ──────────────────
 *
 * A handler behind this guard with no `@RequirePermission` is refused, exactly
 * as `JwtAuthGuard` refuses a route with no `@Roles`. The alternative — treat
 * an undeclared route as «any permission will do» — means the next operator
 * endpoint someone writes is open to READ_ONLY by default, and nothing says so.
 */
@Injectable()
export class OperatorAuthGuard implements CanActivate {
  /** The header the console sends. Distinct from `Authorization`, which on this
   * deployment always means a FAMILY token — one header, one population. */
  static readonly SESSION_HEADER = 'x-operator-session';

  constructor(
    private readonly reflector: Reflector,
    private readonly innerKeyGuard: InternalAdminGuard,
    private readonly sessions: OperatorSessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // GATE 1. Throws its own UnauthorizedException, which is the right answer
    // and is deliberately not caught and re-wrapped.
    await this.innerKeyGuard.canActivate(context);

    const required = this.reflector.getAllAndOverride<Permission | undefined>(REQUIRED_PERMISSION_METADATA, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) {
      // A declaration bug, not a caller bug — but it still fails closed, and it
      // says so loudly enough to be found in a log.
      throw new UnauthorizedException({
        code: 'ROUTE_PERMISSION_UNDECLARED',
        message: 'This operator route declares no required permission and is therefore refused.',
      });
    }

    const request = context.switchToHttp().getRequest();
    const header = request?.headers?.[OperatorAuthGuard.SESSION_HEADER];
    const token = Array.isArray(header) ? header[0] : header;

    const session = await this.sessions.resolve(typeof token === 'string' ? token : undefined);
    if (!session) throw OperatorAuthGuard.refuse();

    if (!roleHasPermission(session.role, required)) throw OperatorAuthGuard.refuse();

    // The identity every audited mutation downstream reads. Set only after both
    // gates and the permission check have passed, so its presence IS the proof
    // that they did.
    (request as { operator?: OperatorSession }).operator = session;
    return true;
  }

  /** One refusal, one shape. See the header. */
  private static refuse(): UnauthorizedException {
    return new UnauthorizedException({
      code: 'OPERATOR_UNAUTHORIZED',
      message: 'Operator authentication failed.',
      messageAr: 'تعذّر التحقّق من هوية المشغّل.',
    });
  }
}
