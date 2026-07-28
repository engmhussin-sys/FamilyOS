import { Injectable } from '@nestjs/common';
import type { Child } from '@prisma/client';

import { PrismaService } from '../../../../common/prisma/prisma.service';
import type { ICreateChildInput, IUpdateChildInput } from '../../domain/child.types';
import type { IChildRepository } from '../../application/ports/child.repository.port';

@Injectable()
export class PrismaChildRepository implements IChildRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(familyId: string, input: ICreateChildInput): Promise<Child> {
    return this.prisma.child.create({
      data: {
        familyId,
        firstName: input.firstName,
        lastName: input.lastName,
        dateOfBirth: new Date(input.dateOfBirth),
        gender: input.gender,
        avatarUrl: input.avatarUrl,
      },
    });
  }

  findManyByFamily(familyId: string): Promise<Child[]> {
    return this.prisma.child.findMany({
      where: { familyId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
  }

  findOneScopedToFamily(childId: string, familyId: string): Promise<Child | null> {
    return this.prisma.child.findFirst({
      where: { id: childId, familyId, deletedAt: null },
    });
  }

  update(childId: string, input: IUpdateChildInput): Promise<Child> {
    return this.prisma.child.update({
      where: { id: childId },
      data: {
        firstName: input.firstName,
        lastName: input.lastName,
        dateOfBirth: input.dateOfBirth ? new Date(input.dateOfBirth) : undefined,
        gender: input.gender,
        avatarUrl: input.avatarUrl,
        isActive: input.isActive,
      },
    });
  }

  async softDelete(childId: string): Promise<void> {
    await this.prisma.child.update({
      where: { id: childId },
      data: { deletedAt: new Date(), isActive: false },
    });
  }
}
