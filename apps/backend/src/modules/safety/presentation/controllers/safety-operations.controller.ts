import { BadRequestException, Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { IsBoolean, IsIn, IsOptional, IsString, Length } from 'class-validator';
import { Transform } from 'class-transformer';

import { PlatformAdminSurface } from '../../../../common/authz/roles.decorator';
import { SystemRoute } from '../../../../common/tenancy/system-route.decorator';
import { OperatorAuthGuard } from '../../../operators/presentation/guards/operator-auth.guard';
import { RequirePermission } from '../../../operators/presentation/decorators/require-permission.decorator';
import type { OperatorSession } from '../../../operators/application/operator-session.service';
import { SafetyReviewService } from '../../application/services/safety-review.service';
import { IllegalSafetyTransitionError } from '../../domain/safety-review';
import type { AiAlertStatus } from '../../../ai-core/domain/ai-alert.types';

class QueueQueryDto {
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === 'true' || value === true)
  openOnly?: boolean;
}

class ReviewDto {
  /** ESCALATED is absent: it has its own route and its own permission. */
  @IsIn(['REVIEWED', 'DISMISSED', 'NEW'])
  status!: 'REVIEWED' | 'DISMISSED' | 'NEW';

  /**
   * MANDATORY, and long enough to be a sentence. The note is the entire value
   * of the escalation trail — «escalated» with no words tells the next person
   * that somebody was worried and nothing about why, and that somebody has
   * usually gone home.
   */
  @IsString()
  @Length(10, 2000)
  note!: string;
}

class EscalateDto {
  @IsString()
  @Length(10, 2000)
  note!: string;
}

/**
 * ===========================================================================
 * THE SAFETY DESK — the operator page this data has always belonged on.
 * ===========================================================================
 *
 * `ai-alerts.controller.ts` says in its own header that this data belongs on
 * «an OPERATOR page behind InternalAdminGuard». That page did not exist, and in
 * its absence every distress alert this product has ever raised is unreviewed:
 * `reviewed_at` had no writer, three of the four `AlertStatus` values were
 * unreachable, and a growth alarm counting unreviewed criticals could only ever
 * climb.
 *
 * ── FOUR ROUTES, THREE PERMISSIONS, AND THE LINE BETWEEN THEM ──────────
 *
 *   GET  /system/safety/alerts        `safety.read`          the queue, no words
 *   GET  /system/safety/alerts/:id    `safety.read_content`  the words, audited
 *   POST /system/safety/alerts/:id/review    `safety.review`
 *   POST /system/safety/alerts/:id/escalate  `safety.escalate`
 *
 * READING THE QUEUE AND READING WHAT A CHILD WROTE ARE DIFFERENT ACTS, so they
 * are different permissions on different routes. A support agent can see that
 * an alert exists — which is what «my child's alert was ignored» needs — and
 * cannot read a word of it. Only the safety desk can.
 *
 * ESCALATION IS ITS OWN ROUTE because it is its own permission, and a route
 * that needed two permissions would be a route doing two things. `@RequirePermission`
 * takes exactly one for that reason.
 *
 * ── THE FIRST CONSUMER OF `OperatorAuthGuard` ──────────────────────────
 *
 * These are the only routes in the codebase behind it. Every one of the
 * forty-five older operator routes still sits behind the shared key alone,
 * unchanged — moving them logs every operator out of a live console and belongs
 * in its own deploy. Starting here is deliberate: the newest and most sensitive
 * surface is the one that should never have had a shared secret in front of it.
 *
 * `@PlatformAdminSurface()` is still declared on every route, because the OUTER
 * gate is `InternalAdminGuard` and it asserts that role. Two role models, one
 * per gate, and neither replaced by the other.
 *
 * NO DELETE ROUTE EXISTS, on this controller or anywhere else. Not an omission:
 * an operator may not delete safety history, and migration 0033 revokes UPDATE
 * and DELETE on the notes table so the database refuses it even if a future
 * service forgets.
 */
@Controller('system/safety')
export class SafetyOperationsController {
  constructor(private readonly review: SafetyReviewService) {}

  @Get('alerts')
  @PlatformAdminSurface()
  @RequirePermission('safety.read')
  @SystemRoute(
    'ADMIN_CONSOLE',
    'The safety desk works one queue across every household; a child-distress signal is a platform duty with no single tenant.',
  )
  @UseGuards(OperatorAuthGuard)
  async queue(@Query() query: QueueQueryDto) {
    const rows = await this.review.listQueue({ openOnly: query.openOnly ?? true });
    return {
      alerts: rows,
      open: rows.filter((row) => row.status === 'NEW' || row.status === 'ESCALATED').length,
      // Stated on the response rather than left for the client to infer: this
      // list carries NO title and NO description, by construction.
      contentIncluded: false,
    };
  }

  @Get('alerts/:alertId')
  @PlatformAdminSurface()
  @RequirePermission('safety.read_content')
  @SystemRoute(
    'ADMIN_CONSOLE',
    'The safety desk reads one alert in full; the desk belongs to no household, and every read of the content is audited.',
  )
  @UseGuards(OperatorAuthGuard)
  async read(@Param('alertId', ParseUUIDPipe) alertId: string, @Req() request: { operator: OperatorSession }) {
    return this.review.readAlert(alertId, request.operator);
  }

  @Post('alerts/:alertId/review')
  @PlatformAdminSurface()
  @RequirePermission('safety.review')
  @SystemRoute('ADMIN_CONSOLE', 'The safety desk moves one alert through its review workflow across tenants.')
  @UseGuards(OperatorAuthGuard)
  async reviewAlert(
    @Param('alertId', ParseUUIDPipe) alertId: string,
    @Body() dto: ReviewDto,
    @Req() request: { operator: OperatorSession },
  ) {
    return this.run(alertId, dto.status, request.operator, dto.note);
  }

  @Post('alerts/:alertId/escalate')
  @PlatformAdminSurface()
  @RequirePermission('safety.escalate')
  @SystemRoute('ADMIN_CONSOLE', 'The safety desk escalates one alert across tenants.')
  @UseGuards(OperatorAuthGuard)
  async escalate(
    @Param('alertId', ParseUUIDPipe) alertId: string,
    @Body() dto: EscalateDto,
    @Req() request: { operator: OperatorSession },
  ) {
    return this.run(alertId, 'ESCALATED', request.operator, dto.note);
  }

  /**
   * An illegal move is a 400 NAMING BOTH STATES, not a 500 and not a silent
   * no-op. «You cannot escalate an alert that is already escalated» is a
   * sentence an operator can act on; a stack trace is not, and a quiet success
   * would tell them the escalation happened.
   */
  private async run(alertId: string, to: AiAlertStatus, actor: OperatorSession, note: string) {
    try {
      return await this.review.transition(alertId, to, actor, note);
    } catch (error) {
      if (error instanceof IllegalSafetyTransitionError) {
        throw new BadRequestException({
          code: 'ILLEGAL_ALERT_TRANSITION',
          message: `An alert cannot move from ${error.from} to ${error.to}.`,
          messageAr: `لا يمكن نقل البلاغ من ${error.from} إلى ${error.to}.`,
        });
      }
      throw error;
    }
  }
}
