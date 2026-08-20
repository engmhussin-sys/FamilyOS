import { Controller, Get, HttpStatus, Res } from '@nestjs/common';

import { SystemRoute } from '../../../../common/tenancy/system-route.decorator';
import type { Response } from 'express';

import { PrismaService } from '../../../../common/prisma/prisma.service';
import { RedisService } from '../../../../common/redis/redis.service';

/** Bypasses the global JwtAuthGuard note: this controller has NO guard
 * at all \u2014 orchestrators (Docker, Railway, a load balancer) probe this
 * before the app is considered ready to receive traffic, and cannot
 * authenticate. Deliberately reveals nothing beyond up/down \u2014 no stack
 * traces, no connection strings, no version info an attacker could use. */
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /** Liveness: "is the process running and able to respond at all."
   * Never checks external dependencies \u2014 a liveness probe that fails
   * because the database is briefly slow would cause an orchestrator to
   * kill and restart a perfectly healthy process, which is the opposite
   * of what liveness checks are for. */
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  /** Readiness: "is this instance able to actually serve requests right
   * now" \u2014 checks the two hard dependencies (Postgres, Redis) every
   * request in this backend eventually needs. Returns 503 (not 200 with
   * a body saying "down") so load balancers correctly stop routing here
   * without needing to parse the response body. */
  @Get('ready')
  @SystemRoute('HEALTH_CHECK', 'An orchestrator probe cannot authenticate and must not need a tenant to answer.')
  async ready(@Res() res: Response) {
    const [dbOk, redisOk] = await Promise.all([this.checkDatabase(), this.checkRedis()]);
    const isReady = dbOk && redisOk;

    res
      .status(isReady ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE)
      .json({ status: isReady ? 'ok' : 'degraded', database: dbOk, redis: redisOk });
  }

  private async checkDatabase(): Promise<boolean> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }

  private async checkRedis(): Promise<boolean> {
    try {
      await this.redis.ping();
      return true;
    } catch {
      return false;
    }
  }
}
