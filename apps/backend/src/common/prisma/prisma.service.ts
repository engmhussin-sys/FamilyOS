import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

import { createTenantExtension } from '../tenancy/tenant.extension';

/**
 * Single shared Prisma client for the whole application, wired into Nest's
 * DI/lifecycle. Every repository injects this instead of instantiating its
 * own PrismaClient — that would exhaust Postgres connections under load.
 *
 * F2 (R8): the constructor returns `this.$extends(tenantExtension)` rather than
 * `this`. That one line is what makes tenant isolation structural instead of
 * disciplined:
 *
 *   - Every existing `this.prisma.<model>...` call site — 154 of them across 44
 *     files — becomes tenant-scoped without being edited. Nothing to remember,
 *     nothing to review, no 155th call site that forgets.
 *   - A Prisma extension client is a Proxy that forwards anything it does not
 *     own to the underlying client, so `onModuleInit`, `$connect`,
 *     `$transaction`, `$queryRaw` and this class's own methods keep working
 *     (verified against a real PostgreSQL, including interception INSIDE
 *     `$transaction`).
 *   - Returning an object from a constructor is legal JS, and it is what lets
 *     Nest hand the same extended instance to every consumer of
 *     `PrismaService` without touching a single provider registration.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  /**
   * PRISMA 7: the connection arrives through an ADAPTER, not through
   * `datasource.url` in the schema. That is the version's central change and it
   * removes the native query engine altogether — this deployment has been
   * paying for that binary twice, once in a real production failure (an engine
   * built for openssl-1.1.x refusing to load inside node:20-alpine) and once in
   * a checked-in workaround because `binaries.prisma.sh` answers 403 in our
   * build environments. Neither cost exists any more: `pg` is JavaScript.
   *
   * The URL is read HERE rather than in the schema so the application's
   * credentials and the MIGRATION's credentials can differ — a deploy step may
   * create tables; the running service should not be able to.
   */
  constructor() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      // Fail with the sentence that names the fix, at construction, rather than
      // on the first query in some unrelated request.
      throw new Error('DATABASE_URL is not set. PrismaService cannot open a connection without it.');
    }
    super({ adapter: new PrismaPg({ connectionString }) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this.$extends(createTenantExtension()) as any;
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Prisma connected to the database (tenant guard extension active).');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
