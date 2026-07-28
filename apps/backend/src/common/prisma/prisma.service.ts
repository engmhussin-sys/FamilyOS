import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * Single shared Prisma client for the whole application, wired into Nest's
 * DI/lifecycle. Every repository injects this instead of instantiating its
 * own PrismaClient — that would exhaust Postgres connections under load.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Prisma connected to the database.');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
