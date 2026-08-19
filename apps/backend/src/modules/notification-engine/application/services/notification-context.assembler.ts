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
 *   OR `child_messages`     the existing `findRecentForChild` — but ONLY when
 *                           the candidate is addressed to the PARENT. A
 *                           CHILD-audience candidate reads the CHILD's inbox
 *                           (`child_messages`) instead. See `readHistory`.
 *                           No titles, no bodies from either.
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
  type RecentNotificationFact,
  type RewardFacts,
  type StreakFacts,
} from '../../../notifications/domain/engine/notification-context';
import { resolveTargetAudience } from '../../../notifications/domain/engine/notification-copy';
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
  /**
   * `F1-002` — THE SPECIFIC DOMAIN CAUSE, when the type is a generic one.
   * Passed straight through to `NotificationEventFacts.cause`, which carries the
   * whole argument. Optional, because most producers have nothing more specific
   * to say than their own type.
   */
  readonly cause?: string | null;
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

    /**
     * ======================================================================
     * THE HISTORY IS THE AUDIENCE'S OWN, AND THE AUDIENCE IS RESOLVED HERE.
     * ======================================================================
     *
     * `resolveTargetAudience` is the SAME function `RuleBasedNotificationDecisionProvider`
     * calls to fill `decision.target_audience`, so the stream that is counted
     * and the stream that is written can never be two different streams.
     * Calling it here rather than after `decide()` is forced by the ordering:
     * the provider scores the context, so the context must already hold the
     * right history.
     */
    const audience = resolveTargetAudience(input.eventType, input.childId !== null);
    const recentNotifications = input.childId
      ? await this.readHistory(input.childId, now, audience)
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
        cause: input.cause ?? null,
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
   * ==========================================================================
   * THE FATIGUE HISTORY, SCOPED TO THE AUDIENCE THE NOTIFICATION IS FOR.
   * ==========================================================================
   *
   * THE DEFECT THIS METHOD EXISTS IN THIS SHAPE FOR — measured, against a real
   * PostgreSQL, on a child's first-ever learning-goal completion:
   *
   *     REWARD_GRANTED_CHILD  aud=CHILD  copy=LEARNING_GOAL_ACHIEVED
   *       decision=SUPPRESS reason=SCORE_BELOW_FLOOR score=21 (floor 25)
   *       FATIGUE_PENALTY=-16.67  note="today=2/6 hour=2/3 category=1/2"
   *
   * That `2` was `notifications` — the PARENT'S inbox (`BADGE_EARNED_PARENT`,
   * `REWARD_GRANTED`). The child's own inbox held ONE row. So the child was
   * told about the badge and never told they had earned points, because their
   * parent had had a busy sixty seconds. It was not a first-completion bug: it
   * penalised EVERY child-audience notification in proportion to how loud the
   * parent's day had been.
   *
   * `notification-class.ts` already forbade this in words, on
   * `REWARD_GRANTED_CHILD`'s own `why`: «the two audiences must be capped and
   * scored independently: a parent at their daily maximum must not be able to
   * silence the child's own news about their own work.» This method is that
   * sentence as a query.
   *
   * THE TWO INBOXES ARE TWO TABLES, and that is `deliverNow`'s routing, not an
   * invention here: a PARENT candidate becomes a `notifications` row through
   * `createForFamilyOwner`; a CHILD candidate becomes a `child_messages` row
   * through the approval-gated `draftAiMessageIfAbsent`. Reading `notifications`
   * for a CHILD candidate was therefore never «the child's history read
   * loosely» — it was a different audience's history entirely.
   *
   * THE SAME 24-HOUR WINDOW `SmartNotificationIntegrationService.fetchHistory`
   * uses, anchored to the `now` being evaluated rather than to the wall clock —
   * `PD-N-003`'s point, and the reason a replayed instant produces the same
   * decision twice.
   *
   * The category is derived here rather than stored, because
   * `notification-class.ts` is the one owner of that mapping and the history rows
   * predate the column.
   *
   * NO CAP CONSTANT MOVED WITH THIS FIX, and that is a decision rather than an
   * omission. `notification.cap.maxPerDay` (6) and `notification.cap.categoryMaxPerDay`
   * (2) are byte-for-byte Sprint 16's `DEFAULT_FATIGUE_POLICY`, and Sprint 16
   * counted them over `findRecentForChild` — i.e. over the PARENT'S rows about
   * one child, which is exactly what the PARENT branch below still reads. So
   * neither number was ever calibrated against a merged two-audience stream and
   * neither is invalidated by separating them; the parent's budget is
   * unchanged, and the child now has a budget of their own that is the same
   * size. Six child-facing notifications a day is the number this product
   * already decided a single stream should carry, and the child's stream is not
   * a lesser stream — see the `why` quoted above. Changing it to make an
   * arithmetic come out is how a cap stops meaning anything.
   */
  private async readHistory(
    childId: string,
    now: Date,
    audience: 'PARENT' | 'CHILD',
  ): Promise<RecentNotificationFact[]> {
    const since = new Date(now.getTime() - HISTORY_WINDOW_HOURS * 60 * 60 * 1000);
    try {
      return audience === 'CHILD'
        ? await this.readChildInbox(childId, since)
        : await this.readParentInbox(childId, since);
    } catch (err) {
      // An empty history is the CONSERVATIVE failure here in one direction and
      // the permissive one in the other: the fatigue penalty reads zero and a
      // notification that should have been throttled is not. That is the right
      // trade — the alternative is refusing every notification whenever a read
      // fails, which turns a transient database blip into total silence.
      this.logger.warn(
        `notification.history_read_failed child=${childId.slice(0, 8)} audience=${audience} — scoring with empty history. ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return [];
    }
  }

  /** The PARENT's inbox, unchanged: `notifications` rows about this child, read
   * through the port that has always read them. */
  private async readParentInbox(childId: string, since: Date): Promise<RecentNotificationFact[]> {
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
  }

  /**
   * The CHILD's inbox: the `child_messages` rows the child's own app renders.
   *
   * THREE COLUMNS, and the same data-minimisation discipline as every other read
   * in this file — no `title`, no `body`, no `data`. A scoring term needs to
   * know that a message happened, what kind it was and when; it has never needed
   * to know what it said.
   *
   * `sourceEventId != null` IS THE «IS THIS A NOTIFICATION?» TEST, and it is the
   * table's own: `child_messages.source_event_id` is documented NULLABLE
   * precisely because this table ALSO holds PARENT-AUTHORED messages, and NULL
   * there means «a human wrote this». A parent typing «أحسنت» to their child is
   * a conversation, not a notification, and counting it towards a notification
   * fatigue cap would let a warm parent mute the product's own feedback loop —
   * the same class of mistake, one table over, as the one this method fixes.
   *
   * `category` HOLDS THE NOTIFICATION TYPE on this path — `deliverNow` passes
   * `candidate.type` into `draftAiMessageIfAbsent`'s `category` parameter — so
   * it is mapped through `notificationCategoryOf` exactly like the parent
   * branch's `type`, and both branches hand the scorer the same vocabulary.
   *
   * PRIORITY IS `NORMAL` FOR EVERY ROW, stated rather than guessed: this table
   * has no priority column, because a child's message surface has never had a
   * loudness axis. Nothing in `scoreNotification` reads `priority` off a history
   * row — it counts them and buckets them by category — so this is an honest
   * filler for a required field and not a value any decision turns on.
   */
  private async readChildInbox(childId: string, since: Date): Promise<RecentNotificationFact[]> {
    const rows = await (this.prisma as any).childMessage.findMany({
      where: { childId, createdAt: { gte: since }, sourceEventId: { not: null } },
      select: { category: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
    return (rows as Array<{ category: string; createdAt: Date }>).map((m) => ({
      type: m.category,
      category: notificationCategoryOf(m.category),
      priority: 'NORMAL' as const,
      createdAt: m.createdAt,
    }));
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
