import { Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';

import { NotificationsService } from '../../application/services/notifications.service';
import { JwtAuthGuard } from '../../../auth/presentation/guards/jwt-auth.guard';
import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import type { IJwtPayload } from '../../../auth/domain/auth.types';

@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get()
  list(@Query('unreadOnly') unreadOnly: string | undefined, @CurrentUser() user: IJwtPayload) {
    return this.notificationsService.list(user.sub, unreadOnly === 'true');
  }

  @Get('unread-count')
  countUnread(@CurrentUser() user: IJwtPayload) {
    return this.notificationsService.countUnread(user.sub);
  }

  @Patch(':id/read')
  markAsRead(@Param('id') id: string, @CurrentUser() user: IJwtPayload) {
    return this.notificationsService.markAsRead(id, user.sub);
  }

  @Post('read-all')
  markAllAsRead(@CurrentUser() user: IJwtPayload) {
    return this.notificationsService.markAllAsRead(user.sub);
  }
}
