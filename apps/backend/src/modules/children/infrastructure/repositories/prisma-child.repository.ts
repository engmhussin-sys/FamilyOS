import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../../common/prisma/prisma.service';
import {
  CHILD_CLIENT_SELECT,
  type ICreateChildInput,
  type IUpdateChildInput,
  type IChildView,
  type IChildWithPinCredential,
} from '../../domain/child.types';
import type { IChildRepository } from '../../application/ports/child.repository.port';

/**
 * `CHILD_CLIENT_SELECT` is on EVERY read and write below. That is the
 * whole security property: `pinCodeHash` is not selected, so it is never
 * loaded into this process on a path that can reach a client, and a
 * column added to `Child` later is invisible here until someone adds it
 * to the whitelist on purpose.
 */
@Injectable()
export class PrismaChildRepository implements IChildRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(familyId: string, input: ICreateChildInput): Promise<IChildView> {
    return this.prisma.child.create({
      data: {
        familyId,
        firstName: input.firstName,
        lastName: input.lastName,
        dateOfBirth: new Date(input.dateOfBirth),
        gender: input.gender,
        avatarUrl: input.avatarUrl,
      },
      select: CHILD_CLIENT_SELECT,
    });
  }

  findManyByFamily(familyId: string): Promise<IChildView[]> {
    return this.prisma.child.findMany({
      where: { familyId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: CHILD_CLIENT_SELECT,
    });
  }

  findOneScopedToFamily(childId: string, familyId: string): Promise<IChildView | null> {
    return this.prisma.child.findFirst({
      where: { id: childId, familyId, deletedAt: null },
      select: CHILD_CLIENT_SELECT,
    });
  }

  /** The one query that reads the credential. Same family scoping as its
   * sibling above, so it cannot be used to reach another family's child
   * either. */
  findOneWithPinCredentialScopedToFamily(
    childId: string,
    familyId: string,
  ): Promise<IChildWithPinCredential | null> {
    return this.prisma.child.findFirst({
      where: { id: childId, familyId, deletedAt: null },
      select: { ...CHILD_CLIENT_SELECT, pinCodeHash: true },
    });
  }

  update(childId: string, input: IUpdateChildInput): Promise<IChildView> {
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
      select: CHILD_CLIENT_SELECT,
    });
  }

  async softDelete(childId: string): Promise<void> {
    await this.prisma.child.update({
      where: { id: childId },
      data: { deletedAt: new Date(), isActive: false },
    });
  }
}
