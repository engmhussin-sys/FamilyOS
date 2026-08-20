import { Test } from '@nestjs/testing';

import { SupportService } from '../../src/modules/support/application/services/support.service';
import { SUPPORT_REQUEST_REPOSITORY } from '../../src/modules/support/domain/support.types';
import { EntitlementsService } from '../../src/modules/billing/application/services/entitlements.service';

describe('SupportService', () => {
  const repositoryMock = { create: jest.fn() };
  const entitlementsMock = { hasFeature: jest.fn() };
  let service: SupportService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        SupportService,
        { provide: SUPPORT_REQUEST_REPOSITORY, useValue: repositoryMock },
        { provide: EntitlementsService, useValue: entitlementsMock },
      ],
    }).compile();
    service = moduleRef.get(SupportService);
  });

  it('creates a support request with the submitted fields, isPriority false when no familyId', async () => {
    repositoryMock.create.mockResolvedValue({
      id: 'req-1',
      familyId: null,
      userId: null,
      email: 'parent@example.com',
      subject: 'Cannot log in',
      message: 'I forgot my password and the reset email never arrives.',
      isPriority: false,
      createdAt: new Date(),
    });

    const result = await service.submit({
      email: 'parent@example.com',
      subject: 'Cannot log in',
      message: 'I forgot my password and the reset email never arrives.',
    });

    expect(repositoryMock.create).toHaveBeenCalledWith({
      familyId: null,
      userId: null,
      email: 'parent@example.com',
      subject: 'Cannot log in',
      message: 'I forgot my password and the reset email never arrives.',
      isPriority: false,
    });
    expect(entitlementsMock.hasFeature).not.toHaveBeenCalled();
    expect(result.id).toBe('req-1');
  });

  it('works WITHOUT any auth context — no logged-in user required', async () => {
    repositoryMock.create.mockResolvedValue({
      id: 'req-2',
      familyId: null,
      userId: null,
      email: 'stranger@example.com',
      subject: 'Question before signing up',
      message: 'Does this support iOS yet?',
      isPriority: false,
      createdAt: new Date(),
    });

    const result = await service.submit({
      email: 'stranger@example.com',
      subject: 'Question before signing up',
      message: 'Does this support iOS yet?',
    });

    expect(result.familyId).toBeNull();
    expect(result.userId).toBeNull();
  });

  it('passes through optional familyId/userId context when supplied', async () => {
    entitlementsMock.hasFeature.mockResolvedValue(false);
    repositoryMock.create.mockResolvedValue({
      id: 'req-3',
      familyId: 'family-1',
      userId: 'user-1',
      email: 'parent@example.com',
      subject: 'Billing question',
      message: 'Why was I charged twice?',
      isPriority: false,
      createdAt: new Date(),
    });

    // F2: the identity is now a SECOND argument, built by the controller from
    // the verified token — it can no longer be smuggled in through the body.
    await service.submit(
      {
        email: 'parent@example.com',
        subject: 'Billing question',
        message: 'Why was I charged twice?',
      },
      { familyId: 'family-1', userId: 'user-1' },
    );

    expect(repositoryMock.create).toHaveBeenCalledWith(
      expect.objectContaining({ familyId: 'family-1', userId: 'user-1' }),
    );
  });

  describe('priority_support entitlement (proactive business/code audit)', () => {
    it('CLOSES A REAL GAP: sets isPriority true when the family has priority_support', async () => {
      entitlementsMock.hasFeature.mockResolvedValue(true);
      repositoryMock.create.mockResolvedValue({
        id: 'req-4',
        familyId: 'family-1',
        userId: 'user-1',
        email: 'vip@example.com',
        subject: 'Urgent',
        message: 'Need help now.',
        isPriority: true,
        createdAt: new Date(),
      });

      await service.submit(
        { email: 'vip@example.com', subject: 'Urgent', message: 'Need help now.' },
        { familyId: 'family-1', userId: 'user-1' },
      );

      expect(entitlementsMock.hasFeature).toHaveBeenCalledWith('family-1', 'priority_support');
      expect(repositoryMock.create).toHaveBeenCalledWith(expect.objectContaining({ isPriority: true }));
    });

    it('does NOT check entitlements at all when no familyId is supplied (unauthenticated submission)', async () => {
      repositoryMock.create.mockResolvedValue({
        id: 'req-5',
        familyId: null,
        userId: null,
        email: 'anon@example.com',
        subject: 'Question',
        message: 'Hi',
        isPriority: false,
        createdAt: new Date(),
      });

      await service.submit({ email: 'anon@example.com', subject: 'Question', message: 'Hi' });

      expect(entitlementsMock.hasFeature).not.toHaveBeenCalled();
    });
  });
});
