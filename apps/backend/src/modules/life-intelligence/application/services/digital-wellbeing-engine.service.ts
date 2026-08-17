import { Inject, Injectable, ForbiddenException } from '@nestjs/common';

import { ChildrenService } from '../../../children/application/services/children.service';
import { LIFE_TIMELINE_WRITER, ILifeTimelineWriter } from '../../domain/life-timeline.types';
import { forRecurringSignal } from '../../../../shared/notifications/notification-source-key';
import { PrismaDigitalWellbeingRepository } from '../../infrastructure/repositories/prisma-digital-wellbeing.repository';
import { ConsentCheckService } from '../../../consent-check/application/consent-check.service';
import { BaselineCalculatorService } from './baseline-calculator.service';
import { PatternDetectionService } from './pattern-detection.service';
import { AnomalyDetectionService } from './anomaly-detection.service';
import { SmartNotificationEngineService } from '../../../notification-engine/application/services/smart-notification-engine.service';
import { FamilyDateService } from '../../../../common/time/family-date.service';
import { getBusinessDate, getBusinessDayOfWeek } from '../../../../common/time/family-date';
import {
  BehaviorPatternCode,
  IBehavioralSnapshotSummary,
  ICriticalWellbeingEventInput,
  IDailyUsageSummary,
  IDailyUsageSummaryInput,
  IWellbeingInsight,
} from '../../domain/digital-wellbeing.types';

const SNAPSHOT_WINDOW_DAYS = 30;
const RECURRENCE_LOOKBACK_DAYS = 7;

// Sprint 14 — deterministic recommendation text per pattern code, per
// the brief's own "Deterministic Behavioral Engine -> Structured
// Insight -> Optional AI explanation" pipeline. No LLM call for this.
const RECOMMENDATIONS: Partial<Record<BehaviorPatternCode, string>> = {
  EXCESSIVE_USAGE: 'Consider a short conversation about today\'s screen time and setting a shared goal for tomorrow.',
  NIGHT_USAGE_INCREASE: 'Consider reviewing bedtime device rules together.',
  GAMING_SPIKE: 'A gentle check-in about what\'s happening in the game right now (a new release, a friend\'s invite) often explains a spike better than a rule change.',
  SOCIAL_SPIKE: 'Worth asking casually what\'s going on socially — spikes are often tied to a real event, not a problem on their own.',
  STUDY_DECLINE: 'Consider checking in about upcoming schoolwork or whether something is making study time harder right now.',
  FRAGMENTED_ATTENTION: 'Frequent short sessions can indicate notification-driven checking — reviewing notification settings together may help.',
  LONG_SESSION: 'A friendly reminder to take a break during long sessions can help.',
};

/**
 * Digital Wellbeing Engine (Edge-First Intelligence Architecture).
 * CLOSES A REAL GAP: BehavioralIntelligenceEngineService's own
 * docstring (ai-core, frozen) explicitly named this pipeline as
 * unbuilt. Lives entirely in life-intelligence — ai-core is never
 * imported or modified.
 *
 * Sprint 14 (Behavioral Intelligence Engine): recordDailySummary now
 * runs the full Baseline -> Pattern Detection -> Anomaly Detection
 * pipeline after every upload, per the brief's own required data
 * flow. Every step is deterministic (no LLM), and every detected
 * pattern carries a real, inspectable explanation.
 */
@Injectable()
export class DigitalWellbeingEngineService {
  constructor(
    private readonly repository: PrismaDigitalWellbeingRepository,
    private readonly childrenService: ChildrenService,
    @Inject(LIFE_TIMELINE_WRITER) private readonly timeline: ILifeTimelineWriter,
    /** PHASE E (`PD-N-004`) — the one gate, replacing a direct
     * `IRuntimeAlertRepository` write. That repository is still the writer;
     * this producer simply no longer reaches it without passing the
     * quiet-hours classification first. */
    /**
     * PHASE F (`F6-003`, closing `PF-E-001`) — the DECISION layer. Phase E
     * routed this producer through the delivery gate; this phase routes it
     * through the layer that decides, records and WORDS the notification. The
     * gate itself is unchanged and is still what the engine calls.
     */
    private readonly notifications: SmartNotificationEngineService,
    private readonly consentCheck: ConsentCheckService,
    private readonly baselineCalculator: BaselineCalculatorService,
    private readonly patternDetection: PatternDetectionService,
    private readonly anomalyDetection: AnomalyDetectionService,
    private readonly familyDate: FamilyDateService,
  ) {}

  /** The daily batch upload — one call per device per day, carrying
   * an already-locally-aggregated summary. Deliberately NOT a hot path. */
  async recordDailySummary(
    childId: string,
    familyId: string,
    deviceId: string,
    input: IDailyUsageSummaryInput,
  ): Promise<IDailyUsageSummary> {
    await this.childrenService.assertChildBelongsToFamily(childId, familyId);

    const consented = await this.consentCheck.hasConsent(childId, 'APP_USAGE_MONITORING');
    if (!consented) {
      throw new ForbiddenException('APP_USAGE_MONITORING consent has not been granted for this child.');
    }

    const isFirstEver = (await this.repository.findSnapshotsInWindow(childId, new Date(0))).length === 0;

    const result = await this.repository.upsertDailySummary(childId, deviceId, input);

    if (isFirstEver) {
      await this.timeline.record({
        childId,
        sourceEngine: 'digital-wellbeing',
        category: 'HABITS',
        eventType: 'first_wellbeing_snapshot',
        title: 'Started tracking daily digital wellbeing',
      });
      // A brand-new child has zero baseline yet — nothing more for
      // the pipeline below to meaningfully do on day one.
      return result;
    }

    // Sprint 14 — the core pipeline: Baseline -> Pattern Detection ->
    // Anomaly Detection -> persist results -> milestone-only Timeline
    // writes. Runs AFTER the raw upload above succeeds — a detection
    // failure must never prevent the raw data itself from being saved.
    await this.runDetectionPipeline(childId, input);

    return result;
  }

  private async runDetectionPipeline(childId: string, input: IDailyUsageSummaryInput): Promise<void> {
    const usageDate = new Date(input.usageDate);
    const baseline = await this.baselineCalculator.compute(childId, usageDate);

    const educationMinutes = this.sumCategory(input.appBreakdown, 'EDUCATION');
    const gamingMinutes = this.sumCategory(input.appBreakdown, 'GAMING');
    const socialMinutes = this.sumCategory(input.appBreakdown, 'SOCIAL');

    const detected = this.patternDetection.detect(
      {
        totalScreenMinutes: input.totalScreenMinutes,
        gamingMinutes,
        socialMinutes,
        educationMinutes,
        nightUsageMinutes: input.nightUsageMinutes,
        sessionCount: input.sessionCount ?? null,
        averageSessionMinutes: input.averageSessionMinutes ?? null,
        longestSessionMinutes: input.longestSessionMinutes ?? null,
        isWeekend: this.isWeekend(input.usageDate),
      },
      baseline,
    );

    const negativePatterns = detected.filter((p) => !p.isPositive).map((p) => p.code);
    const positivePatterns = detected.filter((p) => p.isPositive).map((p) => p.code);
    const baselineDeviationPercent = baseline && baseline.averageScreenMinutes > 0
      ? Math.round(((input.totalScreenMinutes - baseline.averageScreenMinutes) / baseline.averageScreenMinutes) * 100)
      : null;

    await this.repository.updateDetectionResults(childId, input.usageDate, negativePatterns, positivePatterns, baselineDeviationPercent);

    // Recurrence check (AnomalyDetectionService) — needs today's
    // just-written patterns included as the most-recent day.
    const recentHistory = await this.repository.findRecentPatterns(childId, usageDate, RECURRENCE_LOOKBACK_DAYS);
    const recurrence = this.anomalyDetection.detectRecurrence([
      negativePatterns as BehaviorPatternCode[],
      ...(recentHistory.slice(1) as BehaviorPatternCode[][]),
    ]);

    // Timeline: milestone-only, per the brief's own explicit
    // instruction — NOT every pattern, only genuinely significant
    // ones (escalated recurrence, or any positive pattern worth
    // celebrating).
    for (const anomaly of recurrence) {
      if (anomaly.isEscalated) {
        await this.timeline.record({
          childId,
          sourceEngine: 'digital-wellbeing',
          category: 'HABITS',
          eventType: 'behavior_pattern_detected',
          title: `Recurring pattern: ${anomaly.code.replace(/_/g, ' ').toLowerCase()}`,
          metadata: { code: anomaly.code, consecutiveDays: anomaly.consecutiveDays, explanation: anomaly.explanation },
        });
      }
    }
    if (positivePatterns.length > 0) {
      await this.timeline.record({
        childId,
        sourceEngine: 'digital-wellbeing',
        category: 'HABITS',
        eventType: 'healthy_usage_pattern',
        title: 'Healthy digital wellbeing pattern observed',
        metadata: { patterns: positivePatterns },
      });
    }
  }

  private sumCategory(appBreakdown: IDailyUsageSummaryInput['appBreakdown'], category: string): number {
    return appBreakdown.filter((a) => a.category === category).reduce((sum, a) => sum + a.minutes, 0);
  }

  /**
   * B2. The day-of-week now comes from `getBusinessDayOfWeek`, which reads a
   * `YYYY-MM-DD` business date as a calendar day rather than re-deriving it
   * from a `Date`'s UTC fields.
   *
   * STILL OPEN, AND STATED RATHER THAN QUIETLY FIXED: this returns
   * Saturday/Sunday. The weekend in both launch markets is Friday/Saturday
   * (Egypt and Saudi Arabia both). That is a PRODUCT definition, not a
   * timezone defect, it changes which days a `WEEKEND_*` behaviour pattern
   * fires on, and it is out of scope for B1+B2 — it is recorded in the
   * report's `افتراضات ومخاطر مفتوحة`.
   */
  private isWeekend(businessDate: string): boolean {
    const day = getBusinessDayOfWeek(businessDate, 'UTC');
    return day === 0 || day === 6;
  }

  /**
   * The near-real-time critical-event channel.
   *
   * PHASE E (`PD-N-004`) — THIS PRODUCER NOW GOES THROUGH THE GATE.
   *
   * It used to call `createForFamilyOwner` directly. Phase D built the
   * quiet-hours matrix, the deferral queue and the release job, classified
   * `SCREEN_TIME_EXCEEDED`, `POLICY_VIOLATION` and `CHILD_REQUEST` as `DEFER`
   * with a written justification each — and recorded, honestly, that this
   * method reached none of it. A parent in Cairo could be woken at 02:00 by a
   * SCREEN-TIME LIMIT: not a safety risk, precisely the product failure the
   * phase existed to remove, on three of its five types.
   *
   * TWO THINGS CHANGE BESIDES THE ROUTE, and both were latent defects the
   * route was hiding:
   *
   *   1. `type` IS NOW SENT. This call passed no `type`, so every wellbeing
   *      alert was stored as the generic `RUNTIME_ALERT` and the real event
   *      type survived only inside `data.alertType`. The matrix keys on type,
   *      so even a routed call would have classified all five identically —
   *      and the per-type dedup window, cooldown and category cap were all
   *      counting five different events as one.
   *   2. `now` IS A PARAMETER. A deferral computes a persisted instant on the
   *      family's calendar, and Phase D named an injectable clock here as the
   *      minimum precondition for this fix, because the alternative is a suite
   *      whose result depends on what time CI runs. Defaulted, so the one
   *      production call site is unchanged.
   *
   * The two DELIVER-class types (`ACCESSIBILITY_DISABLED`,
   * `PROTECTION_BYPASS_ATTEMPT`) still bypass quiet hours AND the fatigue
   * caps — see `evaluateAndDeliver`, where that bypass now happens before the
   * guard rather than behind it. Safety behaviour is preserved deliberately;
   * what changed is that the three types nobody argued should wake a household
   * no longer do.
   */
  async recordCriticalEvent(
    childId: string,
    familyId: string,
    input: ICriticalWellbeingEventInput,
    now: Date = new Date(),
  ): Promise<void> {
    await this.childrenService.assertChildBelongsToFamily(childId, familyId);

    // B9 (PA-B-007 / PA-B-008) — the causal key is composed HERE, by the
    // producer, and is unchanged: the discriminator is the EVENT TYPE, so two
    // DIFFERENT critical events inside the same window are two notifications
    // while the same event retried by a flaky device sync is one. Carrying it
    // through the gate is what makes that hold across a deferral too — the key
    // composed at 00:30 is the key inserted at 07:00.
    // PHASE F (`F6-003`) — AND THE TITLE AND BODY ARE NO LONGER THE CALLER'S.
    //
    // `input.title` and `input.body` arrive on a DTO from
    // `POST /life-intelligence/:childId/wellbeing/critical-event`, which a
    // paired DEVICE calls. They were written verbatim into a parent's
    // notification. Routing through the engine replaces them with the
    // `COPY_CATALOGUE` entry for the type — «انتهى وقت الشاشة المخصص لـ محمد
    // اليوم. التفاصيل داخل التطبيق.» — so the parent-facing sentence is written
    // in this repository rather than supplied by a client, and it names the
    // child, which the DTO could not do without being told the name.
    //
    // The caller's text is NOT discarded: `input.title` still labels the
    // timeline entry below, where it is the device's own account of what it
    // observed and is read inside the app by an authenticated parent.
    //
    // AND THE `priority` THIS METHOD USED TO COMPUTE IS GONE, deliberately.
    // It was `eventType === 'CHILD_REQUEST' ? 'NORMAL' : 'CRITICAL'` — the
    // pre-Phase-D implicit rule, kept alive as a fallback for a type nobody
    // had classified. All five of this producer's types ARE classified by
    // name in `notification-class.ts` (two DELIVER, three DEFER, each with a
    // written justification), so `quietHoursClassOf` reaches the table before
    // it ever reaches the CRITICAL rule and the value could not change any
    // outcome. Priority now follows the SCORED BAND, which is the axis it was
    // pretending to be — and the safety bypass is unchanged, because the
    // provider's DELIVER override reads the type, never the priority.
    await this.notifications.handleEvent({
      familyId,
      childId,
      eventType: input.eventType,
      sourceEventId: forRecurringSignal('wellbeing', childId, input.eventType, now),
      trigger: 'SAFETY_SIGNAL',
      // PHASE E (`PD-N-004`) — the producer's payload, carried verbatim into
      // `notifications.data`, where the parent app reads a wellbeing alert's
      // specifics. The engine passes it through untouched.
      data: { alertType: input.eventType, ...input.metadata },
      now,
    });

    if (input.eventType !== 'CHILD_REQUEST') {
      await this.timeline.record({
        childId,
        sourceEngine: 'digital-wellbeing',
        category: 'SAFETY',
        eventType: input.eventType.toLowerCase(),
        title: input.title,
        metadata: input.metadata,
      });
    }
  }

  /** Feeds Digital Twin's `behavior` slot as an ADDITIONAL signal
   * alongside ai-core's Risk/Trust trend — DigitalTwinService itself
   * decides how the two combine; this method only ever returns this
   * engine's own honest view, never guesses at ai-core's. */
  async getBehavioralSnapshotSummary(childId: string, familyId: string): Promise<IBehavioralSnapshotSummary | null> {
    await this.childrenService.assertChildBelongsToFamily(childId, familyId);

    const since = await this.daysAgo(familyId, SNAPSHOT_WINDOW_DAYS);
    const snapshots = await this.repository.findSnapshotsInWindow(childId, since);

    if (snapshots.length === 0) return null;

    const sum = (key: 'totalScreenMinutes' | 'pickupCount' | 'nightUsageMinutes' | 'blockedAttemptCount') =>
      snapshots.reduce((acc, s) => acc + s[key], 0);

    return {
      windowDays: SNAPSHOT_WINDOW_DAYS,
      averageDailyScreenMinutes: Math.round(sum('totalScreenMinutes') / snapshots.length),
      averagePickups: Math.round(sum('pickupCount') / snapshots.length),
      averageNightUsageMinutes: Math.round(sum('nightUsageMinutes') / snapshots.length),
      totalBlockedAttempts: sum('blockedAttemptCount'),
      daysWithData: snapshots.length,
    };
  }

  async getTopAppsToday(childId: string, familyId: string, deviceId: string): Promise<Array<{ packageName: string; minutes: number }>> {
    await this.childrenService.assertChildBelongsToFamily(childId, familyId);
    return this.repository.getTopAppsToday(childId, deviceId, await this.todayColumn(familyId));
  }

  /** Sprint 14 — Parent Insights. Deterministic template, not an LLM
   * call, per the brief's own explicit cost/privacy/speed reasoning.
   * Returns null for a day with no snapshot at all (never fabricates
   * an insight from nothing). */
  async getWellbeingInsight(childId: string, familyId: string, date: string): Promise<IWellbeingInsight | null> {
    await this.childrenService.assertChildBelongsToFamily(childId, familyId);

    const snapshot = await this.repository.findSnapshotByDate(childId, date);
    if (!snapshot) return null;

    const baseline = await this.baselineCalculator.compute(childId, new Date(date));

    const detected = this.patternDetection.detect(
      {
        totalScreenMinutes: snapshot.totalScreenMinutes,
        gamingMinutes: snapshot.gamingMinutes ?? 0,
        socialMinutes: snapshot.socialMinutes ?? 0,
        educationMinutes: snapshot.educationMinutes ?? 0,
        nightUsageMinutes: snapshot.nightUsageMinutes,
        sessionCount: snapshot.sessionCount,
        averageSessionMinutes: snapshot.averageSessionMinutes,
        longestSessionMinutes: snapshot.longestSessionMinutes,
        isWeekend: this.isWeekend(date),
      },
      baseline,
    );

    const baselineDeviationPercent = baseline && baseline.averageScreenMinutes > 0
      ? Math.round(((snapshot.totalScreenMinutes - baseline.averageScreenMinutes) / baseline.averageScreenMinutes) * 100)
      : null;

    const primaryNegative = detected.find((p) => !p.isPositive);
    const recommendation = primaryNegative ? RECOMMENDATIONS[primaryNegative.code] ?? null : null;

    return {
      childId,
      date,
      humanSummary: this.buildHumanSummary(snapshot.totalScreenMinutes, baselineDeviationPercent, detected),
      baselineDeviationPercent,
      patterns: detected,
      recommendation,
    };
  }

  /** A plain string template — the brief's own worked example
   * ("Phone usage is 42% higher than usual over the last 3 days, and
   * the increase is mainly from gaming after 10pm") built from real
   * numbers, never an LLM call. */
  private buildHumanSummary(totalScreenMinutes: number, deviationPercent: number | null, patterns: { code: BehaviorPatternCode }[]): string {
    if (deviationPercent === null) {
      return `Today's screen time was ${totalScreenMinutes} minutes. Not enough history yet to compare against this child's usual pattern.`;
    }
    if (deviationPercent > 0) {
      const drivers = patterns.filter((p) => p.code === 'GAMING_SPIKE' || p.code === 'SOCIAL_SPIKE' || p.code === 'NIGHT_USAGE_INCREASE');
      const driverText = drivers.length > 0 ? `, driven mainly by ${drivers.map((d) => d.code.replace(/_/g, ' ').toLowerCase()).join(' and ')}` : '';
      return `Screen time was ${Math.abs(deviationPercent)}% higher than this child's usual pattern today${driverText}.`;
    }
    if (deviationPercent < 0) {
      return `Screen time was ${Math.abs(deviationPercent)}% lower than this child's usual pattern today.`;
    }
    return `Screen time was in line with this child's usual pattern today.`;
  }

  /** B2: `DailyBehavioralSnapshot.usageDate` is a `@db.Date` holding a business
   * date, so "today" is the family's calendar day anchored at UTC midnight. */
  private async todayColumn(familyId: string): Promise<Date> {
    const tz = await this.familyDate.timeZoneOf(familyId);
    return FamilyDateService.toDateColumn(getBusinessDate(new Date(), tz));
  }

  private async daysAgo(familyId: string, days: number): Promise<Date> {
    const tz = await this.familyDate.timeZoneOf(familyId);
    return FamilyDateService.toDateColumn(
      FamilyDateService.addDays(getBusinessDate(new Date(), tz), -days),
    );
  }
}
