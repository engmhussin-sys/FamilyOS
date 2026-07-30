import { Module } from '@nestjs/common';

import { SettingsController } from './presentation/controllers/settings.controller';
import { SettingsService } from './application/settings.service';
import { PrismaSettingsRepository } from './infrastructure/prisma-settings.repository';
import { SETTINGS_REPOSITORY } from './domain/settings.types';

@Module({
  controllers: [SettingsController],
  providers: [
    SettingsService,
    { provide: SETTINGS_REPOSITORY, useClass: PrismaSettingsRepository },
  ],
})
export class SettingsModule {}
