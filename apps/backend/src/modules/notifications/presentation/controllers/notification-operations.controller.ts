import { BadRequestException, Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';

import { InternalAdminGuard } from '../../../../common/guards/internal-admin.guard';
import { SystemRoute } from '../../../../common/tenancy/system-route.decorator';
import { PlatformAdminSurface } from '../../../../common/authz/roles.decorator';
import { isBusinessDate } from '../../../../common/time/family-date';
import {
  NOTIFICATION_DELIVERY_REPOSITORY,
  type INotificationDeliveryRepository,
} from '../../application/ports/notification-delivery.repository.port';
import {
  NOTIFICATION_DECISION_REPOSITORY,
  type DecisionBreakdownReport,
  type INotificationDecisionRepository,
} from '../../application/ports/notification-decision.repository.port';
import { TONE_BANDS } from '../../domain/engine/notification-tone';

/**
 * THE WINDOW CAP, AND WHY IT IS 92 AND NOT A ROUND NUMBER.
 *
 * 92 days is one calendar quarter's worst case (31 + 31 + 30), which is the
 * longest period a product review actually asks for, and it is BYTE-FOR-BYTE
 * the cap `NotificationAnalyticsController` already enforces on
 * `GET /system/notifications/analytics`. The two surfaces are read on the same
 * screen; giving them two different maxima would let an operator pull a
 * breakdown over a window the roll-up beside it refused, and then compare them.
 *
 * The cap is not decoration. `notification_decisions` gains a row for every
 * decision this product ever makes and the query has no other mandatory
 * predicate, so an unbounded `from` is a full scan of the whole ledger on an
 * endpoint an operator can hold F5 on.
 */
const MAX_RANGE_DAYS = 92;

/**
 * THE DEFAULT WINDOW when the caller sends no dates: the last 30 days
 * inclusive. Also `NotificationAnalyticsController`'s, and for the same reason
 * as the cap — the page must not open showing two different periods.
 */
const DEFAULT_RANGE_DAYS = 29;

/**
 * THE TOP-N CAP on the two OPEN vocabularies (notification type, cause).
 *
 * Audience, source, provenance and date are bounded by the schema and by the
 * window; `notification_type` and `event_type` are written by producers, so
 * their cardinality grows with the codebase and an unbounded list is a response
 * whose size nobody controls. 20 is chosen to be READ, not to be complete: it
 * is roughly one screen of table, and the response says `typesTruncated` /
 * `causesTruncated` so a list that filled the cap admits it rather than
 * pretending to be the whole population.
 */
const TOP_LIMIT = 20;

/**
 * PHASE D (`PC-D-005`) — THE OPERATOR SURFACE FOR A NOTIFICATION THAT DIED.
 *
 * WHY IT EXISTS. Phase C's `PC-B-002` found that the outbox had a `DEAD` status
 * and a `maxAttempts` and gave nobody a way to see either, and the notification
 * path was worse: it had no terminal state at all. `PushNotificationService.
 * sendToDevice` caught every FCM error and returned — a stale token, an offline
 * device or a revoked credential produced one `logger.warn` and nothing else.
 * There was no number anywhere in this product for «notifications we owe and
 * cannot deliver».
 *
 * WHY THE GAUGE COUNTS `dead` SEPARATELY FROM `pending`, EXPLICITLY. Phase C
 * measured the alternative: `OutboxRelay.backlog()` counted `PENDING/FAILED`
 * only, so a message reaching DEAD made the number go DOWN and the alert got
 * quieter exactly as the incident got worse. `SQL_DELIVERY_BACKLOG` cannot do
 * that — the two counts are two columns.
 *
 * WHY THERE IS NO `POST .../recover` HERE, unlike the outbox. The refusal is
 * deliberate and it is Phase C's own argument re-applied rather than reversed:
 * a dead notification has failed eight times with exponential backoff, and
 * requeueing it on a button — let alone a timer — is how a poison row becomes a
 * loop. But there is a second reason specific to notifications, and it is the
 * stronger one: A NOTIFICATION IS PERISHABLE. Recovering a «you earned a
 * reward» announcement three days late is not a recovery, it is a confusing
 * message about a Tuesday. The operator action that matters here is fixing the
 * cause (a rotated FCM credential, a device that never re-registered), after
 * which the NEXT notification works — and the dead rows stay as evidence of
 * what the household did not receive.
 *
 * READS ARE NOT AUDITED, deliberately, for the reason `SchedulerOperationsController`
 * states: auditing reads of the observability surface is how the audit table
 * becomes the largest store of personal data in the system.
 */
@Controller('system/notifications')
export class NotificationOperationsController {
  constructor(
    @Inject(NOTIFICATION_DELIVERY_REPOSITORY)
    private readonly deliveries: INotificationDeliveryRepository,
    @Inject(NOTIFICATION_DECISION_REPOSITORY)
    private readonly decisions: INotificationDecisionRepository,
  ) {}

  /**
   * The one call an operator makes. Counts and type names only — never a title,
   * a body, a child id or a family id, because «which household» is not needed
   * to triage «FCM credentials are rotated» and putting it here would make a
   * platform dashboard a place children's notification text is readable.
   */
  @Get('deliveries')
  @PlatformAdminSurface()
  @SystemRoute(
    'ADMIN_CONSOLE',
    'Undeliverable-notification gauge over notification_deliveries; cross-tenant because a permanently failed delivery is a platform-level condition, behind InternalAdminGuard.',
  )
  @UseGuards(InternalAdminGuard)
  async backlog() {
    return this.deliveries.backlog();
  }

  /**
   * THE DECISION LOG, AS AN OPERATOR READS IT.
   *
   * WHY THIS EXISTS BESIDE `GET /system/notifications/analytics` RATHER THAN
   * INSIDE IT. That route answers «what is the platform's suppression rate»
   * with one row of grand totals and rates. It is the right shape for a KPI
   * panel and the wrong shape for the question an operator has when the rate
   * moves, which is always «WHERE» — which audience, which type, which source,
   * which provider, which day, which cause. A grand total cannot be drilled
   * into, and widening the roll-up until it could would have given the rates a
   * `GROUP BY` that makes every one of them a rate over three rows.
   *
   * WHAT IT DELIBERATELY IS NOT: an analytics platform. There is no free-form
   * dimension parameter, no pivot, no cohort and no drill-through to a row. The
   * six slices below are fixed in SQL precisely so that «what can this endpoint
   * be asked» has a written answer, and so that no future query string can turn
   * it into `GROUP BY family_id`.
   *
   * PLATFORM-WIDE, AND THEREFORE ANONYMOUS BY CONSTRUCTION. A parent token
   * cannot reach it — `InternalAdminGuard` reads an operator header and never
   * a JWT, and the route declares `@PlatformAdminSurface()` so
   * `controller-guard-coverage.spec.ts` fails if it ever admits a second role.
   * Nothing it returns names a household: the response's own keys are counts
   * plus closed-vocabulary bucket names, the underlying table stores no title
   * or body at all (migration 0018 argues that at length), and the three
   * statements select no `family_id`, no `child_id` and no `source_event_id`.
   * `decision-analytics-breakdown.e2e.spec.ts` asserts that on the REAL payload keys
   * rather than on this paragraph.
   *
   * BOUNDED IN BOTH DIRECTIONS, and both bounds are re-checked in the
   * repository so a non-HTTP caller cannot get an unbounded scan. See
   * `MAX_RANGE_DAYS` and `TOP_LIMIT` above for what each number is and why.
   *
   * READS ARE NOT AUDITED, for the same reason `deliveries` above is not.
   */
  @Get('decision-breakdown')
  @PlatformAdminSurface()
  @SystemRoute(
    'ADMIN_CONSOLE',
    'Notification decision breakdown over notification_decisions, sliced by audience, notification type, source, provenance, business date and cause; cross-tenant because «which audience is the suppression in» is a platform-level question, behind InternalAdminGuard, and returning counts and closed-vocabulary bucket names only — never a title, a body, a child id or a family id.',
  )
  @UseGuards(InternalAdminGuard)
  async decisionBreakdown(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('country') country?: string,
    @Query('ageBand') ageBand?: string,
    @Query('audience') audience?: string,
    @Query('category') category?: string,
  ): Promise<DecisionBreakdownReport> {
    const toDate = this.businessDate(to, 'to') ?? todayUtcDate();
    const fromDate = this.businessDate(from, 'from') ?? daysBefore(toDate, DEFAULT_RANGE_DAYS);

    if (fromDate > toDate) {
      throw new BadRequestException('`from` must not be after `to`');
    }
    // REFUSED, not silently clamped. Clamping would answer a question the
    // operator did not ask and label the answer with the range they typed.
    if (dayDistance(fromDate, toDate) > MAX_RANGE_DAYS) {
      throw new BadRequestException(`Date range must not exceed ${MAX_RANGE_DAYS} days`);
    }
    if (ageBand !== undefined && !(TONE_BANDS as readonly string[]).includes(ageBand)) {
      throw new BadRequestException(
        `Unknown ageBand "${ageBand}". Expected one of ${TONE_BANDS.join(', ')}`,
      );
    }
    if (audience !== undefined && audience !== 'PARENT' && audience !== 'CHILD') {
      throw new BadRequestException('audience must be PARENT or CHILD');
    }
    if (country !== undefined && !/^[A-Z]{2}$/.test(country)) {
      throw new BadRequestException('country must be a two-letter uppercase ISO code');
    }

    return this.decisions.breakdown(
      {
        fromBusinessDate: fromDate,
        toBusinessDate: toDate,
        countryCode: country ?? null,
        ageBand: ageBand ?? null,
        audience: (audience as 'PARENT' | 'CHILD' | undefined) ?? null,
        category: category ?? null,
      },
      { topLimit: TOP_LIMIT, maxRangeDays: MAX_RANGE_DAYS },
    );
  }

  /** Validated with the project's OWN business-date predicate rather than a
   * fresh regex, so «what is a valid date here» has one answer across both
   * platform notification surfaces. */
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
