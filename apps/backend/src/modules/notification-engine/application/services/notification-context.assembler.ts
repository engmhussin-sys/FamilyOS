/**
 * PHASE F (`F6-002`) — THE ASSEMBLER, AND WHERE DATA MINIMISATION IS ACTUALLY
 * ENFORCED.
 *
 * `notification-context.ts` states the rule per field. This file OBEYS it, and
 * the obedience is visible in the `select` clauses: every read below names its
 * columns, and not one of them is a `include: { child: true }`. Reading a whole
 * `Child` row here would put a date of birth, a PIN hash and a device list into
 * the notification layer's memory on every event, and nothing in the decision
 * consumes any of them.
 *
 * WHAT IT READS, AND FROM WHERE:
 *
 *   `families.timezone`     via `FamilyDateService` — the ONE reader of that
 *                           column, so this service does not become a second.
 *   `children`              `first_name` and `date_of_birth`, and the date of
 *                           birth is CONSUMED IMMEDIATELY into an integer age
 *                           and then dropped. It never reaches the context.
 *   `notifications`         type + priority + created_at for the last 24h, via
 *                           the existing `findRecentForChild`. No titles, no
 *                           bodies.
 *   `subscriptions`         plan and status only.
 *   `notification_policy_settings`  the household's own caps.
 *
 * EVERY READ DEGRADES. A missing child, a family with no subscription, a failed
 * settings query — each one falls back to a documented default rather than
 * throwing, because the standing rule on this path is that a notification
 * problem must never fail the reward grant or habit completion that triggered
 * it.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { Inject, Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../../../common/prisma/prisma.service';
import { FamilyDateService } from '../../../../common/time/family-date.service';
import {
  businessAgeInYears,
  getBusinessDate,
  getBusinessTimeHHMM,
} from '../../../../common/time/family-date';
import { ageBandFor } from '../../../ai-core/domain/age-band';
import {
  NOTIFICATION_REPOSITORY,
  type INotificationRepository,
} from '../../../notifications/application/ports/notification.repository.port';
import {
  NOTIFICATION_POLICY_REPOSITORY,
  type INotificationPolicyRepository,
} from '../../../notifications/application/ports/notification-decision.repository.port';
import { notificationCategoryOf } from '../../../../shared/notifications/notification-class';
import {
  resolveLocale,
  type GoalFacts,
  type NotificationContext,
  type RecentActivityFacts,
  type RewardFacts,
  type StreakFacts,
} from '../../../notifications/domain/engine/notification-context';
import {
  resolveNotificationPolicy,
  type NotificationPolicy,
} from '../../../notifications/domain/engine/notification-policy';
import { safetyBandFor, toneBandFor } from '../../../notifications/domain/engine/notification-tone';
import type { NotificationTrigger } from '../../../notifications/domain/engine/notification-decision.types';

/** What a PRODUCER supplies. Everything else on the context is assembled. */
export interface NotificationEventInput {
  readonly familyId: string;
  readonly childId: string | null;
  readonly eventType: string;
  readonly sourceEventId: string;
  readonly trigger: NotificationTrigger;
  readonly variables?: Readonly<Record<string, string | number>>;
  readonly goal?: GoalFacts | null;
  readonly reward?: RewardFacts | null;
  readonly streak?: StreakFacts | null;
  readonly activity?: Partial<RecentActivityFacts>;
  /** Carried verbatim into `notifications.data` — the producer's own payload,
   * untouched by the engine (`PD-N-004`). */
  readonly data?: Record<string, unknown>;
  /** `now` is a parameter for the reason every decision on this path takes one:
   * a persisted score must be reproducible from the row it was computed for. */
  readonly now?: Date;
}

const HISTORY_WINDOW_HOURS = 24;
const KNOWN_PRIORITIES = new Set(['CRITICAL', 'HIGH', 'NORMAL', 'LOW']);

@Injectable()
export class NotificationContextAssembler {
  private readonly logger = new Logger(NotificationContextAssembler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly familyDate: FamilyDateService,
    @Inject(NOTIFICATION_REPOSITORY) private readonly notifications: INotificationRepository,
    @Inject(NOTIFICATION_POLICY_REPOSITORY)
    private readonly policies: INotificationPolicyRepository,
  ) {}

  async assemble(
    input: NotificationEventInput,
  ): Promise<{ context: NotificationContext; policy: NotificationPolicy }> {
    const now = input.now ?? new Date();
    const timeZone = await this.familyDate.timeZoneOf(input.familyId);
    const policy = await this.resolvePolicy(input.familyId);

    const child = input.childId ? await this.readChild(input.childId) : null;
    // THE DATE OF BIRTH IS CONSUMED HERE AND NEVER TRAVELS. `businessAgeInYears`
    // computes the age on the FAMILY'S calendar — a birthday is a local-date
    // fact, and a UTC comparison gets it wrong for a whole day twice a year.
    const childAgeYears = child?.dateOfBirth
      ? businessAgeInYears(child.dateOfBirth, now, timeZone)
      : null;
    const toneBand = toneBandFor(childAgeYears);

    const localTimeHHMM = getBusinessTimeHHMM(now, timeZone);
    const quietHoursActive = isWithinWindow(localTimeHHMM, policy.quietHoursStart, policy.quietHoursEnd);

    const recentNotifications = input.childId
      ? await this.readHistory(input.childId, now)
      : [];

    const context: NotificationContext = {
      familyId: input.familyId,
      childId: input.childId,
      childAgeYears,
      toneBand,
      safetyBand: childAgeYears === null ? safetyBandFor(null, toneBand) : ageBandFor(childAgeYears),
      locale: resolveLocale(await this.readLocale(input.familyId)),
      timeZone,
      countryCode: await this.readCountry(input.familyId),
      event: {
        eventType: input.eventType,
        sourceEventId: input.sourceEventId,
        trigger: input.trigger,
        variables: input.variables ?? {},
      },
      recentActivity: {
        completionsToday: input.activity?.completionsToday ?? 0,
        minutesSinceLastActivity: input.activity?.minutesSinceLastActivity ?? null,
        isEngagedNow: input.activity?.isEngagedNow ?? false,
      },
      recentNotifications,
      goal: input.goal ?? null,
      reward: input.reward ?? null,
      streak: input.streak ?? null,
      preferences: {
        // Preferences live in the SAME table as the caps, under keys the
        // schema vocabulary does not yet include — so today they are the
        // documented defaults (everything ON) and the mechanism that reads them
        // is real. That is the honest state: the parent-facing settings screen
        // for per-category switches is not built, and pretending otherwise by
        // inventing a table would be worse than an empty record with a working
        // consumer.
        parentCategories: {},
        childCategories: {},
        parentAppetite: 0.6,
      },
      quietHours: {
        startHHMM: policy.quietHoursStart,
        endHHMM: policy.quietHoursEnd,
        isActiveNow: quietHoursActive,
        localTimeHHMM,
      },
      subscription: await this.readSubscription(input.familyId),
      now,
      childDisplayName: child?.firstName ?? null,
    };

    return { context, policy };
  }

  /** The family's business date, for the ledger's `business_date` column. */
  businessDateOf(now: Date, timeZone: string): string {
    return getBusinessDate(now, timeZone);
  }

  private async resolvePolicy(familyId: string): Promise<NotificationPolicy> {
    try {
      return resolveNotificationPolicy(await this.policies.readSettings(familyId));
    } catch (err) {
      this.logger.warn(
        `notification.policy_read_failed family=${familyId.slice(0, 8)} — defaults applied. ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return resolveNotificationPolicy({});
    }
  }

  /** TWO COLUMNS. Not the row. */
  private async readChild(
    childId: string,
  ): Promise<{ firstName: string; dateOfBirth: Date } | null> {
    try {
      const row = await (this.prisma as any).child.findUnique({
        where: { id: childId },
        select: { firstName: true, dateOfBirth: true },
      });
      return row ?? null;
    } catch (err) {
      this.logger.warn(
        `notification.child_read_failed child=${childId.slice(0, 8)} — age-neutral copy will be used. ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  /**
   * The household's locale, read from the OWNER's `users.locale`.
   *
   * There is deliberately no `Family.locale` and this does not invent one: one
   * household, one calendar (B2) is a decided principle, one household one
   * LANGUAGE is not, and adding a column to settle it here would be exactly the
   * «invent a second source of truth» that CONTEXT §3 principle 1 forbids.
   * Arabic on any failure, which is the product's first language.
   */
  private async readLocale(familyId: string): Promise<string | null> {
    try {
      const member = await (this.prisma as any).familyMember.findFirst({
        where: { familyId, role: 'OWNER' },
        select: { user: { select: { locale: true } } },
      });
      return member?.user?.locale ?? null;
    } catch {
      return null;
    }
  }

  /** The billing country, for the analytics axis. `null` — an honest absence —
   * for a household that has never subscribed. This product does not derive a
   * country from an IP address and this method does not start. */
  private async readCountry(familyId: string): Promise<string | null> {
    try {
      const sub = await (this.prisma as any).subscription.findFirst({
        where: { familyId },
        select: { countryCode: true },
      });
      return sub?.countryCode ?? null;
    } catch {
      return null;
    }
  }

  private async readSubscription(familyId: string): Promise<{ plan: string; isActive: boolean }> {
    try {
      const sub = await (this.prisma as any).subscription.findFirst({
        where: { familyId },
        select: { plan: true, status: true },
      });
      if (!sub) return { plan: 'FREE', isActive: false };
      return {
        plan: String(sub.plan),
        isActive: sub.status === 'ACTIVE' || sub.status === 'TRIALING' || sub.status === 'GRACE_PERIOD',
      };
    } catch {
      return { plan: 'FREE', isActive: false };
    }
  }

  /**
   * THE SAME 24-HOUR WINDOW `SmartNotificationIntegrationService.fetchHistory`
   * uses, anchored to the `now` being evaluated rather than to the wall clock —
   * `PD-N-003`'s point, and the reason a replayed instant produces the same
   * decision twice.
   *
   * The category is derived here rather than stored, because
   * `notification-class.ts` is the one owner of that mapping and the history rows
   * predate the column.
   */
  private async readHistory(childId: string, now: Date) {
    const since = new Date(now.getTime() - HISTORY_WINDOW_HOURS * 60 * 60 * 1000);
    try {
      const raw = await this.notifications.findRecentForChild(childId, since);
      return raw.map((n) => ({
        type: n.type,
        category: notificationCategoryOf(n.type),
        priority: (KNOWN_PRIORITIES.has(n.priority) ? n.priority : 'NORMAL') as
          | 'CRITICAL'
          | 'HIGH'
          | 'NORMAL'
          | 'LOW',
        createdAt: n.createdAt,
      }));
    } catch (err) {
      // An empty history is the CONSERVATIVE failure here in one direction and
      // the permissive one in the other: the fatigue penalty reads zero and a
      // notification that should have been throttled is not. That is the right
      // trade — the alternative is refusing every notification whenever a read
      // fails, which turns a transient database blip into total silence.
      this.logger.warn(
        `notification.history_read_failed child=${childId.slice(0, 8)} — scoring with empty history. ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return [];
    }
  }
}

/** Handles the overnight wraparound, identically to
 * `notification-fatigue-guard.ts`'s own `isWithinQuietHours`. Duplicated as four
 * lines rather than imported, because importing it would make a pure guard's
 * private helper part of a public contract; `notification-policy.spec.ts`
 * asserts the two agree on the boundary cases. */
function isWithinWindow(currentHHMM: string, startHHMM: string, endHHMM: string): boolean {
  const toMinutes = (hhmm: string): number => {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
  };
  const current = toMinutes(currentHHMM);
  const start = toMinutes(startHHMM);
  const end = toMinutes(endHHMM);
  if (start <= end) return current >= start && current < end;
  return current >= start || current < end;
}
