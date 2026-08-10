import type { ICandidateNotification } from './notification-fatigue-guard';

/**
 * Sprint 16 (Smart Daily Life Layer) — CLOSES A REAL GAP: this is the
 * brief's own explicitly-named "most important point" — turning raw
 * cross-engine signals into DECISION-BASED notifications, never
 * fixed-schedule reminders ("drink water now" on a timer).
 * Deliberately deterministic — NO LLM call — matching the brief's
 * own "Rules/Decision Engine first, LLM only for optional high-level
 * coaching phrasing" instruction, and this codebase's own
 * established PatternDetectionService/AnomalyDetectionService
 * discipline (Sprint 14) of pure, explainable, rule-based logic.
 *
 * Deliberately a plain input snapshot (ISmartNotificationSignals),
 * not a dependency on any specific engine's own internal types —
 * same "reuse the pattern, not the class" principle
 * ISmartTaskContext already established, so this engine is never
 * force-coupled to Digital Safety's or Health's own concrete shapes.
 */

export interface ISmartNotificationSignals {
  currentHourOfDay: number;
  screenMinutesLast90: number;
  isCurrentlyInBlockedOrCriticalApp: boolean;
  hydration: { actualMl: number; targetMl: number };
  studyTask: { isIncomplete: boolean; usualStudyWindowStarted: boolean } | null;
  exerciseStreak: { streakDays: number; todayComplete: boolean } | null;
}

/**
 * Each rule below is INDEPENDENT and EXPLAINABLE — the brief's own
 * worked examples map directly to these three rules, one per
 * example. Returns every candidate that matches (the caller/fatigue
 * guard decides which, if any, actually get sent) — this function
 * itself never decides send-or-not, only "is this situation
 * relevant."
 */
export function evaluateSmartNotificationCandidates(signals: ISmartNotificationSignals): ICandidateNotification[] {
  const candidates: ICandidateNotification[] = [];

  const hydrationRatio = signals.hydration.targetMl > 0 ? signals.hydration.actualMl / signals.hydration.targetMl : 1;
  if (
    signals.screenMinutesLast90 >= 90 &&
    hydrationRatio < 0.5 &&
    !signals.isCurrentlyInBlockedOrCriticalApp
  ) {
    candidates.push({
      type: 'HYDRATION_REMINDER',
      priority: 'NORMAL',
      title: 'Water break?',
      body: "You've been on your device a while — maybe grab some water?",
      targetAudience: 'CHILD',
    });
  }

  if (signals.studyTask?.isIncomplete && signals.studyTask.usualStudyWindowStarted && !signals.isCurrentlyInBlockedOrCriticalApp) {
    candidates.push({
      type: 'STUDY_REMINDER',
      priority: 'NORMAL',
      title: 'Study time',
      body: "It's around your usual study time — ready to get started?",
      targetAudience: 'CHILD',
    });
  }

  if (signals.exerciseStreak && signals.exerciseStreak.streakDays >= 3 && !signals.exerciseStreak.todayComplete) {
    candidates.push({
      type: 'EXERCISE_ENCOURAGEMENT',
      priority: 'LOW',
      title: `Keep your ${signals.exerciseStreak.streakDays}-day streak going!`,
      body: "You haven't logged activity today yet — even a little keeps the streak alive.",
      targetAudience: 'CHILD',
    });
  }

  return candidates;
}
