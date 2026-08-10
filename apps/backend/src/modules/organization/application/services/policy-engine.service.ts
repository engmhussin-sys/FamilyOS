import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../../../../common/prisma/prisma.service';
import type { IPolicyEngine } from '../ports/policy-engine.port';

/**
 * Sprint B2 — CLOSES A REAL GAP: PolicyEngineService did not exist at
 * all before this; IPolicyEngine (Sprint 9) was a declared-only
 * contract. Uses PrismaService directly — same reasoning
 * ConsentCheckService already established in this codebase: a small,
 * single-table read/write concern doesn't need a full Repository
 * Pattern layer to stay testable and swappable.
 *
 * Deliberately does NOT touch ScreenTimePolicy or any existing
 * child-level policy mechanism — per Sprint 9's own explicit note,
 * "a future org-level policy would compose WITH the existing
 * child-level one... left for whoever implements this port to design
 * in detail." This Sprint implements the ORGANIZATION-level half
 * only (School default -> Family override composition is real future
 * work, not guessed at here).
 */
@Injectable()
export class PolicyEngineService implements IPolicyEngine {
  constructor(private readonly prisma: PrismaService) {}

  async getPolicy<T = unknown>(organizationId: string, key: string): Promise<T | null> {
    const row = await this.prisma.organizationPolicy.findUnique({
      where: { organizationId_key: { organizationId, key } },
    });
    return (row?.value as T | undefined) ?? null;
  }

  async setPolicy(organizationId: string, key: string, value: unknown): Promise<void> {
    await this.prisma.organizationPolicy.upsert({
      where: { organizationId_key: { organizationId, key } },
      create: { organizationId, key, value: value as Prisma.InputJsonValue },
      update: { value: value as Prisma.InputJsonValue },
    });
  }

  /** Walks up the parentOrganizationId chain until a value for `key`
   * is found — a School's default policy applies to every Family
   * sub-organization enrolled under it, unless that Family has its
   * own override. Caps at 10 hops as a defensive bound against a
   * corrupted/circular parent chain — real organization hierarchies
   * in this product's own domain are never expected to nest anywhere
   * near that deep; this is a safety net, not a real design
   * constraint. */
  async getEffectivePolicy<T = unknown>(organizationId: string, key: string): Promise<T | null> {
    const MAX_HOPS = 10;
    let currentOrgId: string | null = organizationId;

    for (let hop = 0; hop < MAX_HOPS && currentOrgId; hop++) {
      const direct = await this.getPolicy<T>(currentOrgId, key);
      if (direct !== null) return direct;

      const org: { parentOrganizationId: string | null } | null = await this.prisma.organization.findUnique({
        where: { id: currentOrgId },
        select: { parentOrganizationId: true },
      });
      currentOrgId = org?.parentOrganizationId ?? null;
    }

    return null;
  }
}
