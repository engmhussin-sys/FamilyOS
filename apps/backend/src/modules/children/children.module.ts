import { Module } from '@nestjs/common';

import { ChildrenController } from './presentation/controllers/children.controller';
import { ChildrenService } from './application/services/children.service';
import { PrismaChildRepository } from './infrastructure/repositories/prisma-child.repository';
import { CHILD_REPOSITORY } from './application/ports/child.repository.port';

@Module({
  controllers: [ChildrenController],
  providers: [
    ChildrenService,
    { provide: CHILD_REPOSITORY, useClass: PrismaChildRepository },
  ],
  // Exported so AuthModule can inject ChildrenService into PairingService
  // to verify a childId belongs to the caller's family before issuing a
  // pairing code — see auth.module.ts and pairing.service.ts.
  exports: [ChildrenService],
})
export class ChildrenModule {}
