import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';

import { PlatformAdminSurface } from '../../../../common/authz/roles.decorator';
import { InternalAdminGuard } from '../../../../common/guards/internal-admin.guard';
import { runAsSystemAsync } from '../../../../common/tenancy/system-context';
import { SystemRoute } from '../../../../common/tenancy/system-route.decorator';
import { AuditService } from '../../../audit/application/audit.service';
import { JobObservability } from '../../application/job-observability.service';
import { JobRunner, UnknownJobError } from '../../application/job-runner.service';
import type { JobRunStatus } from '../../domain/job.types';

class ListRunsQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(60)
  jobName?: string;

  @IsOptional()
  @IsUUID()
  familyId?: string;

  @IsOptional()
  @IsIn(['RUNNING', 'SUCCEEDED', 'FAILED'])
  status?: JobRunStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}

class FailuresQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(720)
  windowHours?: number;
}

class SetEnabledDto {
  @IsBoolean()
  enabled!: boolean;
}

/**
 * PHASE C P4 — THE OPERATIONAL SURFACE.
 *
 * Four questions, four routes, and the reason each one exists is that its
 * absence has a name in this project's own audit history:
 *
 *   WHAT JOBS EXIST AND WHEN DID THEY LAST RUN?   `GET /system/jobs`
 *       Before this, «did retention run last night» was answerable only by
 *       reading the container's logs, and the honest answer was «no, and it
 *       never has».
 *   WHAT HAPPENED?                                `GET /system/jobs/runs`
 *       Per-run history with the affected-row counts. This is what turns «the
 *       sweep succeeded» into «the sweep deleted 412 notifications and 0
 *       location events», which is the difference between a claim and a
 *       measurement.
 *   WHAT IS BROKEN?                               `GET /system/jobs/failures`
 *       The bounded-window gauge an alert pages on.
 *   RUN IT NOW / STOP IT.                         `POST /system/jobs/:name/run`
 *                                                 `POST /system/jobs/:name/enabled`
 *       An operator must be able to force a sweep after an incident and to
 *       stop a misbehaving job WITHOUT A DEPLOY. Without the second one, the
 *       only remedy for a job deleting the wrong rows is scaling the service to
 *       zero, which takes the API down with it.
 *
 * BEHIND `InternalAdminGuard`, `@PlatformAdminSurface()` AND `@SystemRoute`,
 * for the same three reasons `OutboxOperationsController` is: the reads are
 * deliberately cross-tenant (that is what makes them an alert), a manual run
 * executes deletes across every household, and a platform operator has no
 * family for the tenant interceptor to bind. The three decorators state the
 * same fact to the three different systems that check it.
 *
 * TENANT-SAFE DESPITE BEING CROSS-TENANT. `familyId` on `GET /runs` is the
 * only tenant-shaped input on this controller, it NARROWS rather than widens,
 * and it is not reachable without the admin key. CONTEXT §3 principle 3 («the
 * familyId never comes from a client») governs family-facing routes deriving
 * their OWN tenant from a token; a platform operator asking «show me this
 * household's rollover history» is the case the principle exists to make
 * auditable, not to forbid — which is why the next paragraph exists.
 *
 * EVERY MUTATION IS AUDITED. A manual run and an enable/disable both write an
 * `audit_logs` row with `actorType: 'SYSTEM'` and the job name as the entity,
 * so «who caused this delete» has an answer that outlives the log retention of
 * whatever ships the container's stdout. The READS are not audited, on
 * purpose: auditing a read of the audit surface is how an audit table becomes
 * the largest table in the database.
 */
@Controller('system/jobs')
export class SchedulerOperationsController {
  constructor(
    private readonly runner: JobRunner,
    private readonly observability: JobObservability,
    private readonly audit: AuditService,
  ) {}

  /** Every registered job: cadence, enabled, last run, next run, failure state. */
  @Get()
  @PlatformAdminSurface()
  @SystemRoute(
    'ADMIN_CONSOLE',
    'Lists every scheduled job with its lease and last outcome; scheduled_jobs is platform configuration with no tenant, behind InternalAdminGuard.',
  )
  @UseGuards(InternalAdminGuard)
  async listJobs() {
    const jobs = await this.observability.listJobs();
    return {
      jobs,
      // The two summary numbers an operator looks at first. Computed here
      // rather than in the client so every consumer agrees on what "alerting"
      // means.
      alerting: jobs.filter((j) => j.alerting).length,
      disabled: jobs.filter((j) => !j.enabled).length,
    };
  }

  /** Run history. Newest first, bounded, optionally narrowed to one job/family/status. */
  @Get('runs')
  @PlatformAdminSurface()
  @SystemRoute(
    'ADMIN_CONSOLE',
    'Reads job_runs history across tenants; a run may belong to any family or to none, behind InternalAdminGuard.',
  )
  @UseGuards(InternalAdminGuard)
  async listRuns(@Query() query: ListRunsQueryDto) {
    const runs = await this.observability.listRuns({
      jobName: query.jobName,
      familyId: query.familyId,
      status: query.status,
      limit: query.limit,
    });
    return { runs, count: runs.length };
  }

  /** The failure gauge, over a bounded window. */
  @Get('failures')
  @PlatformAdminSurface()
  @SystemRoute(
    'ADMIN_CONSOLE',
    'Reads the failed-run gauge across every job and tenant; a failing scheduled job is a platform-level condition, behind InternalAdminGuard.',
  )
  @UseGuards(InternalAdminGuard)
  async failures(@Query() query: FailuresQueryDto) {
    const windowHours = query.windowHours ?? 24;
    const failures = await this.observability.failures(windowHours);
    return {
      windowHours,
      failures,
      total: failures.reduce((sum, row) => sum + row.failedCount, 0),
    };
  }

  /**
   * TRIGGER A RUN BY HAND.
   *
   * Bypasses `next_run_at` and NOTHING ELSE. The lease still applies, so
   * pressing this while a replica is mid-run answers `claimed: false` instead
   * of racing it; the `job_runs` unique key still applies, so pressing it twice
   * for a family that has already rolled over today answers `skipped` instead
   * of double-applying. Both of those are the point — a manual button that
   * suspended the safety properties would be the most dangerous route in the
   * application, since the one job behind it deletes rows.
   */
  @Post(':name/run')
  @PlatformAdminSurface()
  @SystemRoute(
    'ADMIN_CONSOLE',
    'Operator triggers a scheduled job immediately; the job body may delete rows across every tenant, behind InternalAdminGuard.',
  )
  @UseGuards(InternalAdminGuard)
  async run(@Param('name') name: string) {
    try {
      const report = await this.runner.runJob(name, { trigger: 'MANUAL' });
      await this.recordAudit('scheduler.job.manual_run', name, {
        claimed: report.claimed,
        executed: report.executed,
        skipped: report.skipped,
        failed: report.failed,
        affectedRows: report.affectedRows,
        durationMs: report.durationMs,
      });
      return report;
    } catch (err) {
      if (err instanceof UnknownJobError) {
        throw new NotFoundException({ code: 'JOB_NOT_FOUND', messageAr: 'لا توجد مهمة مجدولة بهذا الاسم.' });
      }
      throw err;
    }
  }

  /** The kill switch, and the way back on. */
  @Post(':name/enabled')
  @PlatformAdminSurface()
  @SystemRoute(
    'ADMIN_CONSOLE',
    'Operator enables or disables a scheduled job; scheduled_jobs is platform configuration with no tenant, behind InternalAdminGuard.',
  )
  @UseGuards(InternalAdminGuard)
  async setEnabled(@Param('name') name: string, @Body() dto: SetEnabledDto) {
    const jobs = await this.observability.listJobs();
    const job = jobs.find((j) => j.name === name);
    if (!job) {
      throw new NotFoundException({ code: 'JOB_NOT_FOUND', messageAr: 'لا توجد مهمة مجدولة بهذا الاسم.' });
    }
    // Re-enabling a row whose code no longer exists would produce a job that
    // fails every tick forever. Refused with a reason rather than accepted and
    // then mysterious.
    if (dto.enabled && !job.registered) {
      throw new BadRequestException({
        code: 'JOB_NOT_REGISTERED',
        messageAr: 'هذه المهمة موجودة في القاعدة بلا مُنفِّذ في الكود، ولا يمكن تفعيلها.',
      });
    }

    await this.observability.setEnabled(name, dto.enabled);
    await this.recordAudit('scheduler.job.enabled_changed', name, { enabled: dto.enabled });
    return { name, enabled: dto.enabled };
  }

  /**
   * The audit write runs under a SYSTEM context because the operator has no
   * family: `audit_logs` is PLATFORM_ANNOTATED, so the row is written with
   * `family_id IS NULL`, which is the honest value for «a platform operator did
   * this to the whole deployment». Inventing a family here would put a false
   * tenant on a compliance record.
   */
  private async recordAudit(
    action: string,
    jobName: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await runAsSystemAsync(
      'ADMIN_CONSOLE',
      'Records a platform operator action against a scheduled job; the operator has no family, so the audit row is deliberately tenant-less.',
      async () => {
        await this.audit.record({
          actorType: 'SYSTEM',
          action,
          entityType: 'ScheduledJob',
          // `audit_logs.entity_id` is `uuid`, and a job is named rather than
          // numbered — so the NAME goes in `metadata` where it is readable and
          // the id column gets the deterministic UUIDv5-shaped filler this
          // codebase already uses for non-uuid entities. Deterministic on
          // purpose: two runs of the same job group together in a query.
          entityId: jobNameToUuid(jobName),
          metadata: { jobName, ...metadata },
        });
      },
    );
  }
}

/**
 * A job NAME rendered as a stable UUID, so `audit_logs.entity_id` (a `uuid`
 * column) can hold it without a migration and two audit rows for the same job
 * group together.
 *
 * NOT a real UUIDv5 — it is a deterministic hash formatted as one, and calling
 * it a v5 would be a claim about a namespace that does not exist here. It is
 * only ever used as a grouping key; nothing dereferences it.
 */
function jobNameToUuid(name: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < name.length; i++) {
    h1 = Math.imul(h1 ^ name.charCodeAt(i), 0x01000193) >>> 0;
    h2 = Math.imul(h2 + name.charCodeAt(i), 0x85ebca6b) >>> 0;
  }
  const hex = (n: number): string => n.toString(16).padStart(8, '0');
  const a = hex(h1);
  const b = hex(h2);
  const c = hex((h1 ^ h2) >>> 0);
  const d = hex((h1 + h2) >>> 0);
  return `${a}-${b.slice(0, 4)}-5${b.slice(5, 8)}-8${c.slice(1, 4)}-${c.slice(4)}${d}`;
}
