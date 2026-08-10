import { Test } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';

import { AccountDeletionService } from '../../src/modules/account-deletion/application/services/account-deletion.service';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { USER_REPOSITORY } from '../../src/modules/auth/application/ports/auth.repository.ports';
import { PasswordService } from '../../src/modules/auth/application/services/password.service';
import { ChildrenService } from '../../src/modules/children/application/services/children.service';
import { SubscriptionService } from '../../src/modules/billing/application/services/subscription.service';

describe('AccountDeletionService', () => {
  const prismaMock = {
    familyMember: { findFirst: jest.fn() },
    user: { update: jest.fn() },
    refreshToken: { updateMany: jest.fn() },
  };
  const userRepositoryMock = { findById: jest.fn() };
  const passwordServiceMock = { verify: jest.fn() };
  const childrenServiceMock = { listChildren: jest.fn(), deleteChild: jest.fn() };
  const subscriptionServiceMock = { cancel: jest.fn() };

  let service: AccountDeletionService;
  const userId = 'user-1';
  const familyId = 'family-1';

  const validUser = { id: userId, passwordHash: 'hashed-password' };
  const ownerMembership = { userId, familyId, role: 'OWNER', deletedAt: null };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        AccountDeletionService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: USER_REPOSITORY, useValue: userRepositoryMock },
        { provide: PasswordService, useValue: passwordServiceMock },
        { provide: ChildrenService, useValue: childrenServiceMock },
        { provide: SubscriptionService, useValue: subscriptionServiceMock },
      ],
    }).compile();
    service = moduleRef.get(AccountDeletionService);
  });

  it('throws NotFoundException for an unknown user', async () => {
    userRepositoryMock.findById.mockResolvedValue(null);

    await expect(service.deleteAccount(userId, familyId, 'password')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws ForbiddenException for an incorrect password, and touches NOTHING else', async () => {
    userRepositoryMock.findById.mockResolvedValue(validUser);
    passwordServiceMock.verify.mockResolvedValue(false);

    await expect(service.deleteAccount(userId, familyId, 'wrong-password')).rejects.toBeInstanceOf(ForbiddenException);

    expect(prismaMock.familyMember.findFirst).not.toHaveBeenCalled();
    expect(childrenServiceMock.listChildren).not.toHaveBeenCalled();
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it('throws ForbiddenException for a non-OWNER member — a regular PARENT cannot delete the whole family', async () => {
    userRepositoryMock.findById.mockResolvedValue(validUser);
    passwordServiceMock.verify.mockResolvedValue(true);
    prismaMock.familyMember.findFirst.mockResolvedValue({ ...ownerMembership, role: 'PARENT' });

    await expect(service.deleteAccount(userId, familyId, 'correct-password')).rejects.toBeInstanceOf(ForbiddenException);

    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it('throws ForbiddenException when no membership exists at all for this family', async () => {
    userRepositoryMock.findById.mockResolvedValue(validUser);
    passwordServiceMock.verify.mockResolvedValue(true);
    prismaMock.familyMember.findFirst.mockResolvedValue(null);

    await expect(service.deleteAccount(userId, familyId, 'correct-password')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('proceeds through the FULL deletion sequence for a valid owner: cancel subscription, delete every child, anonymize user, revoke tokens', async () => {
    userRepositoryMock.findById.mockResolvedValue(validUser);
    passwordServiceMock.verify.mockResolvedValue(true);
    prismaMock.familyMember.findFirst.mockResolvedValue(ownerMembership);
    subscriptionServiceMock.cancel.mockResolvedValue(undefined);
    childrenServiceMock.listChildren.mockResolvedValue([{ id: 'child-1' }, { id: 'child-2' }]);

    await service.deleteAccount(userId, familyId, 'correct-password');

    expect(subscriptionServiceMock.cancel).toHaveBeenCalledWith(familyId, userId);
    expect(childrenServiceMock.deleteChild).toHaveBeenCalledWith('child-1', familyId);
    expect(childrenServiceMock.deleteChild).toHaveBeenCalledWith('child-2', familyId);
    expect(prismaMock.user.update).toHaveBeenCalledWith({
      where: { id: userId },
      data: expect.objectContaining({
        email: `deleted-${userId}@deleted.invalid`,
        fullName: 'Deleted User',
        phone: null,
        status: 'DELETED',
        deletedAt: expect.any(Date),
      }),
    });
    expect(prismaMock.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { userId, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it('does NOT fail the whole deletion when the family is on FREE tier (no subscription to cancel)', async () => {
    userRepositoryMock.findById.mockResolvedValue(validUser);
    passwordServiceMock.verify.mockResolvedValue(true);
    prismaMock.familyMember.findFirst.mockResolvedValue(ownerMembership);
    subscriptionServiceMock.cancel.mockRejectedValue(new NotFoundException('No subscription found for this family.'));
    childrenServiceMock.listChildren.mockResolvedValue([]);

    await expect(service.deleteAccount(userId, familyId, 'correct-password')).resolves.toBeUndefined();

    expect(prismaMock.user.update).toHaveBeenCalled();
  });

  it('propagates a genuinely unexpected error from subscription cancellation rather than silently swallowing it', async () => {
    userRepositoryMock.findById.mockResolvedValue(validUser);
    passwordServiceMock.verify.mockResolvedValue(true);
    prismaMock.familyMember.findFirst.mockResolvedValue(ownerMembership);
    subscriptionServiceMock.cancel.mockRejectedValue(new Error('Database connection lost'));

    await expect(service.deleteAccount(userId, familyId, 'correct-password')).rejects.toThrow('Database connection lost');

    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });
});
