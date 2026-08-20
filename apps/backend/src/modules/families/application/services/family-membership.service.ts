import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../../../../common/prisma/prisma.service';
import { Role, type PersistedFamilyRole } from '../../../../common/authz/principal-role';
import { AuditService } from '../../../audit/application/audit.service';

export interface IFamilyMemberView {
  membershipId: string;
  userId: string;
  fullName: string;
  email: string;
  role: PersistedFamilyRole;
  joinedAt: Date;
  isYou: boolean;
}

interface IActingContext {
  familyId: string;
  actingUserId: string;
  ipAddress?: string;
}

/**
 * PHASE C — the three operations A4 §"adversarial parent" said were
 * unreachable and unprotected: see who is in this family, hand the family to
 * someone else, and remove a co-parent.
 *
 * WHY THE ROLE IS CHECKED TWICE. The guard chain already refused anyone who is
 * not `OWNER` before this service was entered. It is checked AGAIN here, and
 * the second check is the authoritative one, because the guard reads a SIGNED
 * BUT POSSIBLY STALE claim: an access token lives 15 minutes, so a parent
 * demoted 30 seconds ago still presents a token that says OWNER. For reading a
 * habit list that is irrelevant. For "remove the other parent" in a custody
 * dispute it is the whole ballgame. So these three read `family_members` inside
 * the same transaction that mutates it, and the database — not a claim — has
 * the last word.
 *
 * WHY REFRESH TOKENS ARE REVOKED. Without it a removed co-parent keeps a valid
 * 30-day refresh token and simply rotates their way back in. Removal that does
 * not end the session is not removal.
 */
@Injectable()
export class FamilyMembershipService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async listMembers(ctx: IActingContext): Promise<IFamilyMemberView[]> {
    // `familyId` is injected by the tenant extension; passing it explicitly as
    // well is the belt-and-braces convention every other service here follows,
    // and it makes the scope readable at the call site.
    const members = await this.prisma.familyMember.findMany({
      where: { familyId: ctx.familyId, deletedAt: null },
      include: { user: { select: { id: true, fullName: true, email: true } } },
      orderBy: [{ role: 'asc' }, { joinedAt: 'asc' }],
    });

    return members.map((m) => ({
      membershipId: m.id,
      userId: m.userId,
      fullName: m.user.fullName,
      email: m.user.email,
      role: m.role as PersistedFamilyRole,
      joinedAt: m.joinedAt,
      isYou: m.userId === ctx.actingUserId,
    }));
  }

  /**
   * Hands the family to another member. Atomic: the outgoing owner is demoted
   * and the incoming one promoted in one transaction, so the family is never
   * observed with two owners or none. Migration 0009 backs that with a partial
   * unique index, so even a future bug in this method fails loudly instead of
   * quietly producing a second owner.
   */
  async transferOwnership(ctx: IActingContext, targetUserId: string): Promise<void> {
    if (targetUserId === ctx.actingUserId) {
      throw new BadRequestException({
        code: 'OWNERSHIP_TRANSFER_TO_SELF',
        messageEn: 'You already own this family.',
        messageAr: 'أنت بالفعل مالك هذه الأسرة.',
      });
    }

    await this.prisma.$transaction(async (tx) => {
      const acting = await tx.familyMember.findFirst({
        where: { familyId: ctx.familyId, userId: ctx.actingUserId, deletedAt: null },
      });
      if (!acting || acting.role !== Role.OWNER) {
        throw new ForbiddenException({
          code: 'ROLE_NOT_PERMITTED',
          messageEn: 'Only the family owner can transfer ownership.',
          messageAr: 'نقل ملكية الأسرة متاح لمالكها فقط.',
        });
      }

      const target = await tx.familyMember.findFirst({
        where: { familyId: ctx.familyId, userId: targetUserId, deletedAt: null },
      });
      // 404, not 403: the target may simply not exist, and a 403 would confirm
      // that a given userId is a member of some other family.
      if (!target) throw new NotFoundException('Family member not found.');

      await tx.familyMember.update({ where: { id: acting.id }, data: { role: Role.PARENT } });
      await tx.familyMember.update({ where: { id: target.id }, data: { role: Role.OWNER } });
    });

    // The outgoing owner's refresh tokens die with the transfer. Their access
    // token still says OWNER for up to 15 minutes, which is exactly why the
    // destructive services re-read the database rather than trusting it.
    await this.prisma.refreshToken.updateMany({
      where: { userId: ctx.actingUserId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    await this.audit.record({
      actorType: 'USER',
      actorUserId: ctx.actingUserId,
      action: 'family.ownership.transferred',
      entityType: 'Family',
      entityId: ctx.familyId,
      metadata: { fromUserId: ctx.actingUserId, toUserId: targetUserId },
      ipAddress: ctx.ipAddress,
    });
  }

  /**
   * Removes a co-parent. Soft delete, matching `AccountDeletionService`'s own
   * documented policy — the membership row is the audit trail of who was ever
   * in this family, and hard-deleting it would erase exactly the evidence a
   * custody dispute needs.
   */
  async removeMember(ctx: IActingContext, targetUserId: string): Promise<void> {
    if (targetUserId === ctx.actingUserId) {
      // Refusing this is what guarantees a family always has an owner. An
      // owner who wants out transfers first, then is removed by the new owner.
      throw new BadRequestException({
        code: 'OWNER_CANNOT_REMOVE_SELF',
        messageEn: 'Transfer ownership before leaving the family.',
        messageAr: 'انقل ملكية الأسرة أولًا قبل مغادرتها.',
      });
    }

    await this.prisma.$transaction(async (tx) => {
      const acting = await tx.familyMember.findFirst({
        where: { familyId: ctx.familyId, userId: ctx.actingUserId, deletedAt: null },
      });
      if (!acting || acting.role !== Role.OWNER) {
        throw new ForbiddenException({
          code: 'ROLE_NOT_PERMITTED',
          messageEn: 'Only the family owner can remove a member.',
          messageAr: 'إزالة أحد أفراد الأسرة متاحة لمالكها فقط.',
        });
      }

      const target = await tx.familyMember.findFirst({
        where: { familyId: ctx.familyId, userId: targetUserId, deletedAt: null },
      });
      if (!target) throw new NotFoundException('Family member not found.');

      await tx.familyMember.update({ where: { id: target.id }, data: { deletedAt: new Date() } });
    });

    await this.prisma.refreshToken.updateMany({
      where: { userId: targetUserId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    await this.audit.record({
      actorType: 'USER',
      actorUserId: ctx.actingUserId,
      action: 'family.member.removed',
      entityType: 'FamilyMember',
      entityId: targetUserId,
      metadata: { removedUserId: targetUserId, byUserId: ctx.actingUserId },
      ipAddress: ctx.ipAddress,
    });
  }
}
