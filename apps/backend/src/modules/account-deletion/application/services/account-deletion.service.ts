import { Inject, Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../../../../common/prisma/prisma.service';
import { USER_REPOSITORY, type IUserRepository } from '../../../auth/application/ports/auth.repository.ports';
import { PasswordService } from '../../../auth/application/services/password.service';
import { ChildrenService } from '../../../children/application/services/children.service';
import { SubscriptionService } from '../../../billing/application/services/subscription.service';

/**
 * CLOSES A REAL GAP found during a proactive business/code audit:
 * zero account/family deletion path existed anywhere in this
 * product — a real gap given GDPR/CCPA-style "right to erasure"
 * requirements. User.status = 'DELETED' and User.deletedAt have
 * existed in the schema since an early sprint, unused by any code
 * until this service.
 *
 * DELIBERATE SCOPE, stated plainly: this is a SOFT deletion —
 * personal identifying fields are anonymized and the account is
 * marked DELETED/inactive immediately, but no row is hard-deleted
 * from the database here. This mirrors AuditLog's own documented
 * policy ("archivable to cold storage after account closure, not
 * deletable while active") and avoids making an irreversible,
 * cross-cutting cascading-delete decision inside a single service
 * method. WHEN actual hard deletion happens (immediately? after a
 * 30-day grace period? never, only anonymized?) is a real product
 * and legal policy decision — not made here, not guessed at.
 *
 * Only the family OWNER may trigger this.
 */
@Injectable()
export class AccountDeletionService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(USER_REPOSITORY) private readonly userRepository: IUserRepository,
    private readonly passwordService: PasswordService,
    private readonly childrenService: ChildrenService,
    private readonly subscriptionService: SubscriptionService,
  ) {}

  async deleteAccount(userId: string, familyId: string, currentPassword: string): Promise<void> {
    const user = await this.userRepository.findById(userId);
    if (!user) {
      throw new NotFoundException('User not found.');
    }

    const passwordValid = await this.passwordService.verify(user.passwordHash, currentPassword);
    if (!passwordValid) {
      throw new ForbiddenException('Current password is incorrect.');
    }

    const membership = await this.prisma.familyMember.findFirst({
      where: { userId, familyId, deletedAt: null },
    });
    if (!membership || membership.role !== 'OWNER') {
      throw new ForbiddenException('Only the family owner can delete the account.');
    }

    try {
      await this.subscriptionService.cancel(familyId, userId);
    } catch (error) {
      if (!(error instanceof NotFoundException)) throw error;
    }

    const children = await this.childrenService.listChildren(familyId);
    for (const child of children) {
      await this.childrenService.deleteChild(child.id, familyId);
    }

    const anonymizedEmail = `deleted-${userId}@deleted.invalid`;
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        email: anonymizedEmail,
        fullName: 'Deleted User',
        phone: null,
        status: 'DELETED',
        deletedAt: new Date(),
      },
    });

    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}
