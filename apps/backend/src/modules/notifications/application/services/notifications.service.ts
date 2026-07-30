import { Inject, Injectable } from '@nestjs/common';

import {
  NOTIFICATION_REPOSITORY,
  type INotificationRepository,
} from '../ports/notification.repository.port';

@Injectable()
export class NotificationsService {
  constructor(
    @Inject(NOTIFICATION_REPOSITORY) private readonly repository: INotificationRepository,
  ) {}

  list(userId: string, unreadOnly: boolean) {
    return this.repository.listForUser(userId, unreadOnly);
  }

  markAsRead(notificationId: string, userId: string) {
    return this.repository.markAsRead(notificationId, userId);
  }

  markAllAsRead(userId: string) {
    return this.repository.markAllAsRead(userId);
  }

  countUnread(userId: string) {
    return this.repository.countUnread(userId);
  }
}
