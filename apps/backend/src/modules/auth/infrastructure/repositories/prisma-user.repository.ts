import { Injectable } from '@nestjs/common';
import type { User, Family, FamilyMember } from '@prisma/client';

import { PrismaService } from '../../../../common/prisma/prisma.service';
import type { IRegisterParentInput } from '../../domain/auth.types';
import type { IUserRepository } from '../../application/ports/auth.repository.ports';

@Injectable()
export class PrismaUserRepository implements IUserRepository {
  constructor(private readonly prisma: PrismaService) {}

  findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { email } });
  }

  findById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  async createParentWithFamily(
    input: IRegisterParentInput,
    passwordHash: string,
  ): Promise<{ user: User; family: Family; membership: FamilyMember }> {
    // A single transaction: either all three rows are created, or none are.
    // This is what guarantees "no orphan User without a Family" as an
    // invariant enforced at the data layer, not just by convention.
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: input.email,
          passwordHash,
          fullName: input.fullName,
          locale: input.locale ?? 'en',
          timezone: input.timezone ?? 'UTC',
          // CLOSES A REAL GAP: acceptedTerms was already enforced at
          // the DTO level (registration fails without it) — this is
          // where that acceptance actually gets recorded, which
          // previously did not happen at all.
          // PLACEHOLDER version string — needs a real legal document
          // with a real version identifier before this is trusted in
          // production, same reasoning as seed.ts's own priceCents
          // placeholders.
          termsAcceptedAt: new Date(),
          termsVersion: 'v1-placeholder',
        },
      });

      const family = await tx.family.create({
        data: {
          name: input.familyName ?? `${input.fullName}'s Family`,
          timezone: input.timezone ?? 'UTC',
        },
      });

      const membership = await tx.familyMember.create({
        data: {
          familyId: family.id,
          userId: user.id,
          role: 'OWNER',
        },
      });

      return { user, family, membership };
    });
  }

  async updateLastLoginAt(userId: string, at: Date): Promise<void> {
    await this.prisma.user.update({ where: { id: userId }, data: { lastLoginAt: at } });
  }

  findPrimaryFamilyMembership(
    userId: string,
  ): Promise<(FamilyMember & { family: Family }) | null> {
    return this.prisma.familyMember.findFirst({
      where: { userId, deletedAt: null },
      include: { family: true },
      orderBy: { joinedAt: 'asc' },
    });
  }
}
