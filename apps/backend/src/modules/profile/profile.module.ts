import { Module } from '@nestjs/common';

import { ProfileController } from './presentation/controllers/profile.controller';
import { ProfileService } from './application/profile.service';
import { PrismaProfileRepository } from './infrastructure/prisma-profile.repository';
import { PROFILE_REPOSITORY } from './domain/profile.types';

@Module({
  controllers: [ProfileController],
  providers: [
    ProfileService,
    { provide: PROFILE_REPOSITORY, useClass: PrismaProfileRepository },
  ],
})
export class ProfileModule {}
