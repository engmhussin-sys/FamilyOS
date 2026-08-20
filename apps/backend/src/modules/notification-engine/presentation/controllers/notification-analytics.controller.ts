/**
 * PHASE F (`F6-002` §9) — THE READ API THE ADMIN DASHBOARD NEEDS, AND NOTHING
 * MORE.
 *
 * The dashboard UI is explicitly out of scope for this phase. What is in scope
 * is that the numbers EXIST and are reachable, so the UI work does not begin by
 * inventing a schema. Every field §9 names is here: sent, suppressed, open rate,
 * action rate, duplicate rate, AI-rewrite rate, delivery failure, top types and
 * fatigue — filterable by country, age band, audience, category and date.
 *
 * WHAT IT REFUSES TO RETURN, and this is `NotificationOperationsController`'s
 * discipline applied to a richer surface: NO TITLE, NO BODY, NO CHILD ID, NO
 * FAMILY ID. The underlying table does not store the first two at all
 * (migration 0018 argues that at length), and the query selects neither of the
 * last two. «Which household» is not needed to triage «suppression is up 40% in
 * Egypt this week», and putting it here would make a platform dashboard the
 * place a child's notifications are readable.
 *
 * ENGINE-BYPASSED NOTIFICATIONS ARE IN THESE NUMBERS, AND THE ANSWER IS
 * EXPLICIT RATHER THAN INCIDENTAL. The two SYSTEM producers on
 * `ENGINE_BYPASS_ALLOWLIST` — the child-distress escalation and the device
 * runtime-integrity alert — now write a `notification_decisions` row of their
 * own (`notification-bypass.ts`), stamped `provider_id = 'safety-bypass'`.
 * This route COUNTS them, because a platform roll-up that hid its own safety
 * traffic would answer «how many escalations went out last week» with a zero it
 * had manufactured. The price is that `suppressionRate`'s DENOMINATOR contains
 * rows that were never eligible for suppression — so the same response carries
 * `bypassed`, the count of exactly those rows, and an operator never has to
 * guess which of the two conventions this endpoint chose. The sibling route,
 * `GET /system/notifications/decision-breakdown`, answers the same question
 * with its PROVENANCE dimension over the SAME population; the two are
 * deliberately not filtered differently.
 *
 * ACTION RATE IS RETURNED AS `null`, DELIBERATELY. This product has no
 * deep-link attribution and no in-app action receipt, so «acted on a
 * notification» cannot be measured today. A fabricated zero would look like a
 * measurement; `null` plus the note in the port's docstring is the honest state
 * and it is reproduced in the phase report's open-risks section.
 *
 * TENANCY. `@SystemRoute` + `@PlatformAdminSurface` + `InternalAdminGuard`, and
 * the repository runs the aggregate inside `runAsSystemAsync` with a written
 * justification — exactly the shape `GET /system/notifications/deliveries`
 * already has. READS ARE NOT AUDITED, for `SchedulerOperationsController`'s
 * stated reason: auditing reads of the observability surface is how the audit
 * table becomes the largest store of personal data in the system.
 */

import { BadRequestException, Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';

import { InternalAdminGuard } from '../../../../common/guards/internal-admin.guard';
import { SystemRoute } from '../../../../common/tenancy/system-route.decorator';
import { PlatformAdminSurface } from '../../../../common/authz/roles.decorator';
import { isBusinessDate } from '../../../../common/time/family-date';
import {
  NOTIFICATION_DECISION_REPOSITORY,
  type DecisionAnalyticsReport,
  type INotificationDecisionRepository,
} from '../../../notifications/application/ports/notification-decision.repository.port';
import { TONE_BANDS } from '../../../notifications/domain/engine/notification-tone';

/** A ceiling on the window, so one query cannot scan the whole table. Ninety-two
 * days covers a quarter, which is the longest period a product review actually
 * asks for. */
const MAX_RANGE_DAYS = 92;
const TOP_TYPES_LIMIT = 15;

@Controller('system/notifications')
export class NotificationAnalyticsController {
  constructor(
    @Inject(NOTIFICATION_DECISION_REPOSITORY)
    private readonly decisions: INotificationDecisionRepository,
  ) {}

  @Get('analytics')
  @PlatformAdminSurface()
  @SystemRoute(
    'ADMIN_CONSOLE',
    'Notification decision analytics over notification_decisions; cross-tenant because a suppression rate is a platform-level number, behind InternalAdminGuard, and returning counts and type names only — never a title, a body, a child id or a family id.',
  )
  @UseGuards(InternalAdminGuard)
  async analytics(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('country') country?: string,
    @Query('ageBand') ageBand?: string,
    @Query('audience') audience?: string,
    @Query('category') category?: string,
  ): Promise<DecisionAnalyticsReport> {
    const toDate = this.businessDate(to, 'to') ?? todayUtcDate();
    const fromDate = this.businessDate(from, 'from') ?? daysBefore(toDate, 29);

    if (fromDate > toDate) {
      throw new BadRequestException('`from` must not be after `to`');
    }
    if (dayDistance(fromDate, toDate) > MAX_RANGE_DAYS) {
      throw new BadRequestException(`Date range must not exceed ${MAX_RANGE_DAYS} days`);
    }
    if (ageBand !== undefined && !(TONE_BANDS as readonly string[]).includes(ageBand)) {
      throw new BadRequestException(`Unknown ageBand "${ageBand}". Expected one of ${TONE_BANDS.join(', ')}`);
    }
    if (audience !== undefined && audience !== 'PARENT' && audience !== 'CHILD') {
      throw new BadRequestException('audience must be PARENT or CHILD');
    }
    if (country !== undefined && !/^[A-Z]{2}$/.test(country)) {
      throw new BadRequestException('country must be a two-letter uppercase ISO code');
    }

    return this.decisions.analytics(
      {
        fromBusinessDate: fromDate,
        toBusinessDate: toDate,
        countryCode: country ?? null,
        ageBand: ageBand ?? null,
        audience: (audience as 'PARENT' | 'CHILD' | undefined) ?? null,
        category: category ?? null,
      },
      TOP_TYPES_LIMIT,
    );
  }

  /** Validated with the project's OWN business-date predicate rather than a
   * fresh regex, so «what is a valid date here» has one answer. */
  private businessDate(raw: string | undefined, label: string): string | null {
    if (raw === undefined || raw === '') return null;
    if (!isBusinessDate(raw)) {
      throw new BadRequestException(`\`${label}\` must be a YYYY-MM-DD date`);
    }
    return raw;
  }
}

function todayUtcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysBefore(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function dayDistance(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00.000Z`);
  const b = Date.parse(`${to}T00:00:00.000Z`);
  return Math.round((b - a) / 86_400_000);
}
