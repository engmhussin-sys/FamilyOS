import { Controller, Get, HttpStatus, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';

import { ReadinessCheckService } from '../../application/readiness-check.service';
import { ConfigurationService } from '../../../../config/configuration.service';
import { FeatureFlagService } from '../../../feature-flags/application/feature-flag.service';
import { InternalAdminGuard } from '../../../../common/guards/internal-admin.guard';
import { PlatformAdminSurface } from '../../../../common/authz/roles.decorator';
import { SystemRoute } from '../../../../common/tenancy/system-route.decorator';

/**
 * AN OPERATOR SURFACE. BOTH ROUTES ARE BEHIND `InternalAdminGuard`.
 *
 * ============================== WHAT WAS WRONG ==============================
 *
 * This controller carried NO guard at all, on the stated reasoning that «every
 * field is deliberately non-sensitive: no secret values, no connection strings,
 * no user data». That is the wrong test. `GET /system/diagnostics` answered ANY
 * ANONYMOUS CALLER with the VERSION, the COMMIT SHA, `NODE_ENV`, the config
 * warning keys and the FULL FEATURE FLAG LIST. No single field is a secret and
 * the RESPONSE is reconnaissance: it names the exact build an attacker is
 * looking at and which features are on, for free, from a public staging or
 * production host.
 *
 * `GET /system/readiness` was anonymous for the same reason and discloses more
 * in kind, not less: its `detail` strings carry the database's own error text
 * when a check fails, WHICH external payment providers are configured, and
 * internal document paths. It is closed here together with its neighbour rather
 * than after the next report — this codebase has already shipped the version of
 * this defect where only the route that was named got fixed.
 *
 * ====================== WHY A GUARD AND NOT A REDACTION =====================
 *
 * The audience for these two routes is an OPERATOR: the Admin Dashboard's
 * status page and whoever is holding a deploy. That is exactly the audience
 * `InternalAdminGuard` + `@PlatformAdminSurface()` names — the same pair
 * `system/jobs` and the AI platform routes already carry — and the guard is
 * left EXACTLY as it is, HMAC-ing both sides and `timingSafeEqual`-ing the
 * digests.
 *
 * THE PLATFORM PROBE ALREADY HAS ITS OWN ENDPOINTS, and they stay anonymous:
 * `GET /health/live` answers `{status}` and `GET /health/ready` answers
 * `{status, database, redis}` — three booleans and a word, nothing about the
 * build. Those are the two the staging deploy config polls; they are excluded
 * from the `api/v1` prefix for exactly that reason, and
 * `test/authz/system-diagnostics-anonymous.e2e.spec.ts` asserts on the REAL
 * response bodies that the anonymous surface still answers and still discloses
 * nothing of the build.
 *
 * `@SystemRoute` stays, and its reason moves from `HEALTH_CHECK` to
 * `ADMIN_CONSOLE`: the guard deliberately does not write `request.user`, so
 * these still run WITHOUT a tenant — but they now do so as an operator console,
 * which is the reason the vocabulary has that word.
 */
@Controller('system')
export class SystemDiagnosticsController {
  constructor(
    private readonly readinessCheck: ReadinessCheckService,
    private readonly configurationService: ConfigurationService,
    private readonly featureFlagService: FeatureFlagService,
  ) {}

  @Get('readiness')
  @PlatformAdminSurface()
  @SystemRoute(
    'ADMIN_CONSOLE',
    'Operator readiness console; component detail carries provider configuration and raw dependency errors, so it reads no tenant rows and is behind InternalAdminGuard. The anonymous probe is GET /health/ready.',
  )
  @UseGuards(InternalAdminGuard)
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
  @PlatformAdminSurface()
  @SystemRoute(
    'ADMIN_CONSOLE',
    'Operator build/config diagnostics; reads FeatureFlag, a global model, and no tenant rows, and the build identity it reports is for an operator only, so it is behind InternalAdminGuard.',
  )
  @UseGuards(InternalAdminGuard)
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
