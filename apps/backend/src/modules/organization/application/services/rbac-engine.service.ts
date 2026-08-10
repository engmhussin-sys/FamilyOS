import { Inject, Injectable } from '@nestjs/common';

import type { IRbacEngine, IPermissionCheck } from '../ports/rbac-engine.port';
import { ORGANIZATION_REPOSITORY, type IOrganizationRepository } from '../ports/organization.repository.port';
import type { OrganizationRoleValue } from '../../domain/organization.types';

/** Sprint B1 — CLOSES A REAL GAP: RbacEngineService did not exist at
 * all before this; IRbacEngine (Sprint 9) was a declared-only
 * contract. Deliberately conservative first pass:
 *
 * - A simple, hardcoded role-hierarchy table, not a fully-configurable
 *   per-resource permission matrix. Sprint 9's own port docstring left
 *   `resource`'s full vocabulary as "a product decision this
 *   architecture pass doesn't make" — this implementation makes the
 *   SAME choice: `resource` is accepted but not yet used to
 *   differentiate permissions. A real, separate follow-up once
 *   actual resources exist to differentiate.
 * - Does NOT replace assertChildBelongsToFamily or any other
 *   family-scoped ownership check anywhere in this codebase — per
 *   Sprint 9's own explicit note, that would be a real refactor of
 *   working, tested code, out of scope. Additive, for the NEW
 *   Organization surface only. */
@Injectable()
export class RbacEngineService implements IRbacEngine {
  constructor(
    @Inject(ORGANIZATION_REPOSITORY) private readonly organizationRepository: IOrganizationRepository,
  ) {}

  private static readonly ROLE_HIERARCHY: Record<OrganizationRoleValue, number> = {
    OWNER: 4,
    ADMIN: 3,
    MANAGER: 2,
    MEMBER: 1,
    GUEST: 0,
  };

  private static readonly ACTION_MIN_LEVEL: Record<IPermissionCheck['action'], number> = {
    READ: 0,
    WRITE: 2,
    DELETE: 4,
    ADMIN: 4,
  };

  async hasPermission(check: IPermissionCheck): Promise<boolean> {
    const role = await this.getRole(check.userId, check.organizationId);
    if (!role) return false;
    return RbacEngineService.ROLE_HIERARCHY[role] >= RbacEngineService.ACTION_MIN_LEVEL[check.action];
  }

  async getRole(userId: string, organizationId: string): Promise<OrganizationRoleValue | null> {
    const members = await this.organizationRepository.findMembers(organizationId);
    const membership = members.find((m) => m.userId === userId);
    return membership?.role ?? null;
  }
}
