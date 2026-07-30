import { Test } from '@nestjs/testing';
import { NotificationsService } from '../../src/modules/notifications/application/services/notifications.service';
import { NOTIFICATION_REPOSITORY } from '../../src/modules/notifications/application/ports/notification.repository.port';

describe('NotificationsService', () => {
  const repositoryMock = {
    listForUser: jest.fn(),
    markAsRead: jest.fn(),
    markAllAsRead: jest.fn(),
    countUnread: jest.fn(),
  };

  let service: NotificationsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [NotificationsService, { provide: NOTIFICATION_REPOSITORY, useValue: repositoryMock }],
    }).compile();
    service = moduleRef.get(NotificationsService);
  });

  it('list delegates unreadOnly flag through to the repository', async () => {
    repositoryMock.listForUser.mockResolvedValue([{ id: 'n1' }]);
    const result = await service.list('user-1', true);
    expect(repositoryMock.listForUser).toHaveBeenCalledWith('user-1', true);
    expect(result).toEqual([{ id: 'n1' }]);
  });

  it('markAsRead delegates and returns the boolean result', async () => {
    repositoryMock.markAsRead.mockResolvedValue(true);
    await expect(service.markAsRead('n1', 'user-1')).resolves.toBe(true);
    expect(repositoryMock.markAsRead).toHaveBeenCalledWith('n1', 'user-1');
  });

  it('markAllAsRead returns the count updated', async () => {
    repositoryMock.markAllAsRead.mockResolvedValue(3);
    await expect(service.markAllAsRead('user-1')).resolves.toBe(3);
  });

  it('countUnread delegates to the repository', async () => {
    repositoryMock.countUnread.mockResolvedValue(2);
    await expect(service.countUnread('user-1')).resolves.toBe(2);
  });
});
