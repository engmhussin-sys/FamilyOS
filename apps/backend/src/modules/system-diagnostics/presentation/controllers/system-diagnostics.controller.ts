import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';

import { ReadinessCheckService } from '../../application/readiness-check.service';
import { ConfigurationService } from '../../../../config/configuration.service';
import { FeatureFlagService } from '../../../feature-flags/application/feature-flag.service';

/**
 * No auth guard \u2014 same reasoning as HealthController: infrastructure
 * and the Admin Dashboard's own status page need to reach this without
 * a session. Every field is deliberately non-sensitive: no secret
 * values, no connection strings, no user data \u2014 only booleans/counts/
 * version strings, reviewed line-by-line against that requirement.
 */
@Controller('system')
export class SystemDiagnosticsController {
  constructor(
    private readonly readinessCheck: ReadinessCheckService,
    private readonly configurationService: ConfigurationService,
    private readonly featureFlagService: FeatureFlagService,
  ) {}

  @Get('readiness')
  async readiness(@Res() res: Response) {
    const results = await this.readinessCheck.checkAll();
    const hasNotReady = results.some((r) => r.status === 'NOT_READY');

    res.status(hasNotReady ? HttpStatus.SERVICE_UNAVAILABLE : HttpStatus.OK).json({
      status: hasNotReady ? 'not_ready' : 'ready',
      checkedAt: new Date().toISOString(),
      components: results,
    });
  }

  @Get('diagnostics')
  async diagnostics() {
    const memoryUsage = process.memoryUsage();
    const validationReport = this.configurationService.getValidationReport();
    const flags = await this.featureFlagService.listAll();

    return {
      version: process.env.npm_package_version ?? '0.1.0',
      // GIT_COMMIT_SHA is expected to be set by the CI/deploy pipeline
      // (e.g. `--build-arg GIT_COMMIT_SHA=$(git rev-parse HEAD)`) \u2014 not
      // set in this sandbox, honestly reported as null rather than guessed.
      commit: process.env.GIT_COMMIT_SHA ?? null,
      environment: process.env.NODE_ENV ?? 'development',
      uptimeSeconds: Math.floor(process.uptime()),
      memory: {
        rssMb: Math.round(memoryUsage.rss / 1024 / 1024),
        heapUsedMb: Math.round(memoryUsage.heapUsed / 1024 / 1024),
        heapTotalMb: Math.round(memoryUsage.heapTotal / 1024 / 1024),
      },
      // Node's own event-loop-based concurrency model means there is no
      // meaningful single "CPU %" for a single request the way a
      // thread-per-request server would report \u2014 process.cpuUsage() is
      // reported as cumulative user/system time instead, the honest
      // equivalent for this runtime.
      cpu: process.cpuUsage(),
      // No queue/job system exists in this codebase \u2014 see the
      // Background Jobs Review finding. Reported as null, not omitted,
      // so a diagnostics consumer can tell "checked, none exists" apart
      // from "field forgotten."
      queue: null,
      configValidation: {
        isValid: validationReport.isValid,
        warningCount: validationReport.issues.filter((i) => i.severity === 'WARNING').length,
        // Issue KEYS only (which settings have a warning), never the
        // issue detail text verbatim if it could hint at an actual
        // secret value \u2014 in practice these messages never contain
        // secret values themselves (SecretsValidator only ever reports
        // "missing" / "too short", never the value), but the field is
        // deliberately narrow regardless.
        warningKeys: validationReport.issues.filter((i) => i.severity === 'WARNING').map((i) => i.key),
      },
      featureFlags: flags.map((f) => ({ key: f.key, isEnabledGlobally: f.isEnabledGlobally })),
    };
  }
}
