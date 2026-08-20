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
          // PHASE F (`F6-009`, `PF-E-002`). ARABIC when the client says nothing.
          // This value chooses the language of every notification the household
          // will ever receive (`NotificationContextAssembler.readLocale`), and
          // CONTEXT §1 fixes the product's first language as Arabic. It must
          // match `schema.prisma`'s own default, because a household created by
          // any other path would otherwise get a different language from one
          // created here.
          locale: input.locale ?? 'ar',
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
          /**
           * F1 — THE FAMILY IS CREATED *WITH* ITS MARKET.
           *
           * This is the only `family.create` in the backend, so it is the only
           * place a household can be born knowing where it is. The alternative
           * shape — create blank, then let the client patch it — makes the column
           * depend on a second request that a crash, a lost connection or a
           * skipped onboarding screen silently cancels, which is how every
           * existing row came to have no country at all.
           *
           * `undefined` when the registration named no market, so Prisma OMITS
           * the column and the row keeps the schema's NULL. Never `''`, and never
           * a defaulted `'EG'`: a wrong country is worse than an absent one,
           * because on the growth dashboard a wrong one is indistinguishable
           * from a measured fact.
           *
           * ALREADY RESOLVED BY `AuthService.register` — normalised, checked
           * against the ACTIVE `countries` rows, with an operator's pilot
           * invitation preferred over the client's claim. Nothing unverified
           * reaches this line, and migration 0022's real foreign key is the
           * backstop if anything ever does.
           */
          countryCode: input.countryCode,
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
