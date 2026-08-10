import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../../../../common/prisma/prisma.service';
import type {
  IOrganization,
  IOrganizationInvitation,
  IOrganizationMember,
  IPartnerCampaign,
  OrganizationRoleValue,
  OrganizationTypeValue,
  PartnerCampaignTypeValue,
} from '../../domain/organization.types';
import type { IOrganizationRepository } from '../../application/ports/organization.repository.port';

/**
 * Sprint B1 — CLOSES A REAL GAP: the Sprint 9 architecture pass built
 * every contract for this (IOrganizationRepository, the schema
 * tables) but explicitly left implementation for "a future Sprint" —
 * this is that Sprint. Mirrors this project's own Repository Pattern
 * discipline exactly (see prisma-child.repository.ts, etc.).
 */
@Injectable()
export class PrismaOrganizationRepository implements IOrganizationRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string): Promise<IOrganization | null> {
    const row = await this.prisma.organization.findUnique({ where: { id } });
    return row ? this.toDomain(row) : null;
  }

  async findByType(type: OrganizationTypeValue): Promise<IOrganization[]> {
    const rows = await this.prisma.organization.findMany({ where: { type, deletedAt: null } });
    return rows.map((row: { id: string; type: string; name: string; parentOrganizationId: string | null; settings: unknown }) => this.toDomain(row));
  }

  async findChildOrganizations(parentOrganizationId: string): Promise<IOrganization[]> {
    const rows = await this.prisma.organization.findMany({
      where: { parentOrganizationId, deletedAt: null },
    });
    return rows.map((row: { id: string; type: string; name: string; parentOrganizationId: string | null; settings: unknown }) => this.toDomain(row));
  }

  async updateSettings(organizationId: string, settings: Record<string, unknown>): Promise<IOrganization> {
    const row = await this.prisma.organization.update({
      where: { id: organizationId },
      data: { settings: settings as Prisma.InputJsonValue },
    });
    return this.toDomain(row);
  }

  async findOrganizationsForUser(userId: string): Promise<IOrganization[]> {
    const memberships = await this.prisma.organizationMember.findMany({
      where: { userId, deletedAt: null },
      include: { organization: true },
    });
    return memberships
      .filter((m: { organization: { deletedAt: Date | null } }) => !m.organization.deletedAt)
      .map((m: { organization: { id: string; type: string; name: string; parentOrganizationId: string | null; settings: unknown } }) => this.toDomain(m.organization));
  }

  async create(input: Omit<IOrganization, 'id'>): Promise<IOrganization> {
    const row = await this.prisma.organization.create({
      data: {
        type: input.type,
        name: input.name,
        parentOrganizationId: input.parentOrganizationId,
        settings: (input.settings ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
    return this.toDomain(row);
  }

  async findMembers(organizationId: string): Promise<IOrganizationMember[]> {
    const rows = await this.prisma.organizationMember.findMany({
      where: { organizationId, deletedAt: null },
    });
    return rows.map((row: { id: string; organizationId: string; userId: string; role: string }) => ({
      id: row.id,
      organizationId: row.organizationId,
      userId: row.userId,
      role: row.role as OrganizationRoleValue,
    }));
  }

  async addMember(organizationId: string, userId: string, role: string): Promise<IOrganizationMember> {
    const row = await this.prisma.organizationMember.create({
      data: { organizationId, userId, role: role as never },
    });
    return { id: row.id, organizationId: row.organizationId, userId: row.userId, role: row.role };
  }

  async createInvitation(input: Omit<IOrganizationInvitation, 'id' | 'status'>): Promise<IOrganizationInvitation> {
    const row = await this.prisma.organizationInvitation.create({
      data: {
        organizationId: input.organizationId,
        email: input.email,
        role: input.role as never,
        expiresAt: input.expiresAt,
        invitedByUserId: input.invitedByUserId,
      },
    });
    return {
      id: row.id,
      organizationId: row.organizationId,
      email: row.email,
      role: row.role,
      status: row.status,
      expiresAt: row.expiresAt,
      invitedByUserId: row.invitedByUserId,
    };
  }

  async findInvitationById(invitationId: string): Promise<IOrganizationInvitation | null> {
    const row = await this.prisma.organizationInvitation.findUnique({ where: { id: invitationId } });
    if (!row) return null;
    return {
      id: row.id,
      organizationId: row.organizationId,
      email: row.email,
      role: row.role,
      status: row.status,
      expiresAt: row.expiresAt,
      invitedByUserId: row.invitedByUserId,
    };
  }

  /** Atomic: updating the invitation's status and creating the
   * membership row happen in a single transaction — an interruption
   * partway through must never leave a member added but the
   * invitation still PENDING (which would allow accepting it twice)
   * or vice versa. */
  async acceptInvitation(invitationId: string, acceptingUserId: string): Promise<IOrganizationMember> {
    return this.prisma.$transaction(async (tx) => {
      const invitation = await tx.organizationInvitation.update({
        where: { id: invitationId },
        data: { status: 'ACCEPTED' },
      });
      const member = await tx.organizationMember.create({
        data: { organizationId: invitation.organizationId, userId: acceptingUserId, role: invitation.role },
      });
      return { id: member.id, organizationId: member.organizationId, userId: member.userId, role: member.role as OrganizationRoleValue };
    });
  }

  async createCampaign(input: Omit<IPartnerCampaign, 'id'>): Promise<IPartnerCampaign> {
    const row = await this.prisma.partnerCampaign.create({
      data: {
        organizationId: input.organizationId,
        code: input.code,
        type: input.type,
        config: input.config as Prisma.InputJsonValue,
        isActive: input.isActive,
        expiresAt: input.expiresAt,
      },
    });
    return {
      id: row.id,
      organizationId: row.organizationId,
      code: row.code,
      type: row.type,
      config: row.config as Record<string, unknown>,
      isActive: row.isActive,
      expiresAt: row.expiresAt,
    };
  }

  async findActiveCampaignByCode(code: string): Promise<IPartnerCampaign | null> {
    const row = await this.prisma.partnerCampaign.findUnique({ where: { code } });
    if (!row || !row.isActive) return null;
    if (row.expiresAt && row.expiresAt < new Date()) return null;
    return {
      id: row.id,
      organizationId: row.organizationId,
      code: row.code,
      type: row.type,
      config: row.config as Record<string, unknown>,
      isActive: row.isActive,
      expiresAt: row.expiresAt,
    };
  }

  async findCampaignsByOrganization(organizationId: string): Promise<IPartnerCampaign[]> {
    const rows = await this.prisma.partnerCampaign.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((row: { id: string; organizationId: string; code: string; type: string; config: unknown; isActive: boolean; expiresAt: Date | null }) => ({
      id: row.id,
      organizationId: row.organizationId,
      code: row.code,
      type: row.type as PartnerCampaignTypeValue,
      config: row.config as Record<string, unknown>,
      isActive: row.isActive,
      expiresAt: row.expiresAt,
    }));
  }

  private toDomain(row: {
    id: string;
    type: string;
    name: string;
    parentOrganizationId: string | null;
    settings: unknown;
  }): IOrganization {
    return {
      id: row.id,
      type: row.type as OrganizationTypeValue,
      name: row.name,
      parentOrganizationId: row.parentOrganizationId,
      settings: (row.settings as Record<string, unknown> | null) ?? null,
    };
  }
}
