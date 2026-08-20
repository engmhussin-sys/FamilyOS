import { ExecutionContext, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import * as fs from 'fs';
import * as path from 'path';

import { BreakGlassGuard } from '../../src/common/authz/break-glass.guard';
import { BreakGlass } from '../../src/common/authz/break-glass.decorator';
import {
  PERSISTED_FAMILY_ROLES,
  PRINCIPAL_ROLES,
  Role,
  isPersistedFamilyRole,
  principalRoleFromToken,
  type PrincipalRole,
} from '../../src/common/authz/principal-role';
import { assertRoleAllowed } from '../../src/common/authz/route-authorizer';
import {
  ChildSurface,
  OwnerOnly,
  ParentSurface,
  PlatformAdminSurface,
  Roles,
} from '../../src/common/authz/roles.decorator';

/**
 * PHASE C / P3 — the role model itself, tested away from HTTP.
 *
 * `intra-family-authorization.e2e.spec.ts` proves the behaviour through the
 * real application; this file pins the DECISION FUNCTION, including the cases
 * an e2e suite cannot reach cheaply: a legacy token with no role claim, a
 * SUPPORT principal (which no token-issuance path in this codebase can
 * produce), and a route that forgot to declare anything at all.
 */

/** Applies a REAL decorator to a REAL function — no hand-written metadata. */
function decorate(dec: MethodDecorator): () => void {
  const holder = {
    handler(): void {
      /* route body */
    },
  };
  dec(holder, 'handler', Object.getOwnPropertyDescriptor(holder, 'handler') as PropertyDescriptor);
  return holder.handler;
}

function contextFor(handler: () => void, user: unknown, ip = '10.0.0.1'): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user, ip }) }),
    getHandler: () => handler,
    getClass: () => class FakeController {},
  } as unknown as ExecutionContext;
}

describe('PHASE C / P3 — the role model', () => {
  const reflector = new Reflector();

  describe('the vocabulary is closed, and only two of its values are persisted', () => {
    it('lists exactly the five principal roles', () => {
      expect([...PRINCIPAL_ROLES].sort()).toEqual(
        ['CHILD', 'OWNER', 'PARENT', 'SUPER_ADMIN', 'SUPPORT'].sort(),
      );
    });

    it('only OWNER and PARENT are ever written to family_members.role', () => {
      // CHILD, SUPPORT and SUPER_ADMIN are derived at authentication time.
      // Widening the Prisma enum to hold them would create three values no
      // INSERT may ever legally use.
      expect([...PERSISTED_FAMILY_ROLES]).toEqual([Role.OWNER, Role.PARENT]);
      expect(isPersistedFamilyRole(Role.CHILD)).toBe(false);
      expect(isPersistedFamilyRole(Role.SUPPORT)).toBe(false);
      expect(isPersistedFamilyRole(Role.SUPER_ADMIN)).toBe(false);
    });

    it('keeps the schema name OWNER rather than renaming it to the client’s ADMIN', () => {
      // The value is persisted in `family_members.role` since migration 0001,
      // returned to the Parent App in the login response, and branched on by
      // `account-deletion.service.ts`. Renaming costs a data migration and a
      // breaking API change and buys nothing.
      expect(Role.OWNER).toBe('OWNER');
      expect(PRINCIPAL_ROLES).not.toContain('ADMIN');
    });
  });

  describe('principalRoleFromToken', () => {
    it('a device token is always CHILD, claim or no claim', () => {
      expect(principalRoleFromToken({ actorType: 'DEVICE' })).toBe(Role.CHILD);
      // Even if something managed to stamp a role on a device token, the
      // actor type wins — there is no claim to get out of sync.
      expect(principalRoleFromToken({ actorType: 'DEVICE', familyRole: 'OWNER' })).toBe(Role.CHILD);
    });

    it('a user token carries its signed role', () => {
      expect(principalRoleFromToken({ actorType: 'USER', familyRole: 'OWNER' })).toBe(Role.OWNER);
      expect(principalRoleFromToken({ actorType: 'USER', familyRole: 'PARENT' })).toBe(Role.PARENT);
    });

    it('a LEGACY user token with no role claim degrades to PARENT, never to OWNER', () => {
      // Tokens minted before this claim existed stay valid for 15 minutes
      // after deploy. Failing closed would 403 every parent in the fleet;
      // failing open to OWNER would be the bug this sprint exists to remove.
      expect(principalRoleFromToken({ actorType: 'USER' })).toBe(Role.PARENT);
    });

    it('a user token with a NONSENSE role claim also degrades to PARENT', () => {
      expect(principalRoleFromToken({ actorType: 'USER', familyRole: 'SUPER_ADMIN' })).toBe(
        Role.PARENT,
      );
      expect(principalRoleFromToken({ actorType: 'USER', familyRole: 'root' })).toBe(Role.PARENT);
    });

    it('an unrecognised actor type resolves to no role at all', () => {
      expect(principalRoleFromToken({ actorType: 'ROBOT' })).toBeUndefined();
      expect(principalRoleFromToken({})).toBeUndefined();
    });
  });

  describe('assertRoleAllowed — the permission matrix', () => {
    const surfaces: Array<[string, () => void]> = [
      ['ParentSurface', decorate(ParentSurface())],
      ['OwnerOnly', decorate(OwnerOnly())],
      ['ChildSurface', decorate(ChildSurface())],
      ['PlatformAdminSurface', decorate(PlatformAdminSurface())],
    ];

    const principalFor = (role: PrincipalRole) =>
      role === Role.CHILD
        ? { sub: 'device-1', actorType: 'DEVICE', familyId: 'fam-1' }
        : { sub: 'user-1', actorType: 'USER', familyId: 'fam-1', familyRole: role };

    /** role -> surfaces it may execute. This table IS the matrix. */
    const ALLOWED: Record<string, string[]> = {
      OWNER: ['ParentSurface', 'OwnerOnly'],
      PARENT: ['ParentSurface'],
      CHILD: ['ChildSurface'],
    };

    for (const role of [Role.OWNER, Role.PARENT, Role.CHILD] as PrincipalRole[]) {
      for (const [name, handler] of surfaces) {
        const shouldPass = ALLOWED[role].includes(name);
        it(`${role} ${shouldPass ? 'MAY' : 'may NOT'} execute a ${name} route`, () => {
          const ctx = contextFor(handler, principalFor(role));
          if (shouldPass) {
            expect(assertRoleAllowed(reflector, ctx)).toBe(true);
          } else {
            expect(() => assertRoleAllowed(reflector, ctx)).toThrow();
          }
        });
      }
    }

    it('PARENT on an OWNER-only route gets 403 with a machine code and an Arabic sentence', () => {
      const ctx = contextFor(decorate(OwnerOnly()), principalFor(Role.PARENT));
      let thrown: ForbiddenException | undefined;
      try {
        assertRoleAllowed(reflector, ctx);
      } catch (e) {
        thrown = e as ForbiddenException;
      }
      expect(thrown).toBeInstanceOf(ForbiddenException);
      const body = thrown?.getResponse() as Record<string, unknown>;
      expect(body.code).toBe('ROLE_NOT_PERMITTED');
      expect(body.requiredRoles).toEqual([Role.OWNER]);
      expect(body.heldRole).toBe(Role.PARENT);
      // CONTEXT §3 principle 7: a statement of fact plus a way forward, no
      // «ممنوع» and no «تجاوزت».
      expect(String(body.messageAr)).toContain('مالك الأسرة');
      expect(String(body.messageAr)).not.toContain('ممنوع');
    });

    it('CHILD on an OWNER-only route gets 403 too — it is still inside the tenant', () => {
      const ctx = contextFor(decorate(OwnerOnly()), principalFor(Role.CHILD));
      expect(() => assertRoleAllowed(reflector, ctx)).toThrow(ForbiddenException);
    });

    it('a DENIED principal with no family gets 404, not 403 — nothing about a tenant is confirmed', () => {
      const ctx = contextFor(decorate(OwnerOnly()), {
        sub: 'user-1',
        actorType: 'USER',
        familyRole: 'PARENT',
      });
      // No `familyId` on the principal, so it cannot be a PROVEN member of any
      // tenant, and the 403 reasoning (see `authz.errors.ts`) does not apply.
      // The denial must be indistinguishable from "no such thing".
      expect(() => assertRoleAllowed(reflector, ctx)).toThrow(NotFoundException);
    });

    it('a PERMITTED principal with no family still passes the ROLE check — tenancy is a separate lock', () => {
      // Stated explicitly because it looks like a hole and is not. This
      // function answers "may this ROLE call this route". Whether the caller
      // has a tenant is decided one layer down, where the global
      // TenantContextInterceptor binds nothing and the Prisma tenant extension
      // then denies every tenant-scoped query by default (F2). Making the role
      // guard also enforce tenancy would duplicate that decision in a second
      // place, free to drift — the exact thing this sprint was told not to do.
      const ctx = contextFor(decorate(ParentSurface()), {
        sub: 'user-1',
        actorType: 'USER',
        familyRole: 'PARENT',
      });
      expect(assertRoleAllowed(reflector, ctx)).toBe(true);
    });

    it('no principal at all gets 404', () => {
      const ctx = contextFor(decorate(ParentSurface()), undefined);
      expect(() => assertRoleAllowed(reflector, ctx)).toThrow(NotFoundException);
    });

    it('a route that declares NO roles is DENIED — fail closed, not open by omission', () => {
      const ctx = contextFor(
        () => undefined,
        { sub: 'user-1', actorType: 'USER', familyId: 'fam-1', familyRole: 'OWNER' },
      );
      let thrown: ForbiddenException | undefined;
      try {
        assertRoleAllowed(reflector, ctx);
      } catch (e) {
        thrown = e as ForbiddenException;
      }
      expect(thrown).toBeInstanceOf(ForbiddenException);
      expect((thrown?.getResponse() as Record<string, unknown>).code).toBe('ROUTE_ROLE_UNDECLARED');
    });

    it('an EMPTY @Roles() is treated the same as none', () => {
      const ctx = contextFor(decorate(Roles()), {
        sub: 'user-1',
        actorType: 'USER',
        familyId: 'fam-1',
        familyRole: 'OWNER',
      });
      expect(() => assertRoleAllowed(reflector, ctx)).toThrow(ForbiddenException);
    });
  });

  describe('SUPPORT — declared, denied, and ungrantable', () => {
    const supportPrincipal = {
      sub: 'agent-1',
      actorType: 'USER',
      familyId: 'fam-1',
      familyRole: 'SUPPORT',
    };

    it('cannot be reached through a token at all: the claim degrades to PARENT', () => {
      // The token claim type is `PersistedFamilyRole`, so this is a
      // compile-time impossibility as well; this asserts the runtime behaviour
      // if a hand-forged (but validly signed) token ever carried it.
      expect(principalRoleFromToken(supportPrincipal)).toBe(Role.PARENT);
    });

    it('is refused on a SUPPORT route that has no @BreakGlass', () => {
      const ctx = contextFor(decorate(Roles(Role.SUPPORT)), supportPrincipal);
      // Forced past the token derivation to test the authorizer's own rule.
      const forced = {
        ...ctx,
        switchToHttp: () => ({
          getRequest: () => ({ user: { ...supportPrincipal, actorType: 'SUPPORT_CONSOLE' } }),
        }),
      } as unknown as ExecutionContext;
      expect(() => assertRoleAllowed(reflector, forced)).toThrow(NotFoundException);
    });

    it('no source file outside common/authz ever names Role.SUPPORT', () => {
      // The mechanism exists; the support console does not. This assertion is
      // what turns "we did not build it" into a fact the build re-checks,
      // rather than a sentence in a report.
      const srcRoot = path.resolve(__dirname, '../../src');
      const offenders: string[] = [];
      const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.isFile() && entry.name.endsWith('.ts')) {
            if (full.includes(path.join('common', 'authz'))) continue;
            if (/Role\.SUPPORT|['"]SUPPORT['"]/.test(fs.readFileSync(full, 'utf8'))) {
              offenders.push(path.relative(srcRoot, full));
            }
          }
        }
      };
      walk(srcRoot);
      expect(offenders).toEqual([]);
    });
  });

  describe('BreakGlassGuard', () => {
    const meta = BreakGlass(
      "a child's activity timeline",
      'A parent reported missing data and explicitly asked support to look.',
    );

    function guardWith(record: jest.Mock): BreakGlassGuard {
      return new BreakGlassGuard(new Reflector(), { record } as never);
    }

    it('writes a tenant-scoped AuditLog row BEFORE letting the request through', async () => {
      const record = jest.fn().mockResolvedValue(undefined);
      const ctx = contextFor(decorate(meta), {
        sub: 'agent-1',
        actorType: 'USER',
        familyId: 'fam-1',
      });

      await expect(guardWith(record).canActivate(ctx)).resolves.toBe(true);
      expect(record).toHaveBeenCalledTimes(1);
      const written = record.mock.calls[0][0];
      expect(written.action).toBe('authz.break_glass.opened');
      expect(written.entityType).toBe('Family');
      // The tenant comes from the VERIFIED token, never the body.
      expect(written.entityId).toBe('fam-1');
      expect(written.metadata.scope).toContain('timeline');
      expect(written.metadata.justification.length).toBeGreaterThan(20);
    });

    it('refuses — and writes nothing — when the route declares no break-glass', async () => {
      const record = jest.fn();
      const ctx = contextFor(decorate(ParentSurface()), {
        sub: 'agent-1',
        actorType: 'USER',
        familyId: 'fam-1',
      });
      await expect(guardWith(record).canActivate(ctx)).rejects.toThrow(NotFoundException);
      expect(record).not.toHaveBeenCalled();
    });

    it('refuses a break-glass with an empty justification', async () => {
      const record = jest.fn();
      const ctx = contextFor(decorate(BreakGlass('anything', '   ')), {
        sub: 'agent-1',
        actorType: 'USER',
        familyId: 'fam-1',
      });
      await expect(guardWith(record).canActivate(ctx)).rejects.toThrow(NotFoundException);
      expect(record).not.toHaveBeenCalled();
    });

    it('refuses when the caller has no family — there is no tenant to scope the audit row to', async () => {
      const record = jest.fn();
      const ctx = contextFor(decorate(meta), { sub: 'agent-1', actorType: 'USER' });
      await expect(guardWith(record).canActivate(ctx)).rejects.toThrow(NotFoundException);
      expect(record).not.toHaveBeenCalled();
    });
  });
});
