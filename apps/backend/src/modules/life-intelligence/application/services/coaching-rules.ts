import { ICoachingRecommendation, ICoachingSignals } from '../../domain/coaching.types';

/**
 * Pure function \u2014 zero I/O, fully deterministic. "Coaching as
 * recommendation generation only. No generative decision making. LLM
 * is used only for wording. Business logic remains deterministic" \u2014
 * this file IS that business logic. An LLM (not wired this sprint)
 * would only be allowed to reword `body` below, never decide WHICH
 * recommendation fires.
 */
export function generateParentCoachRecommendations(signals: ICoachingSignals): ICoachingRecommendation[] {
  const recs: ICoachingRecommendation[] = [];

  if (signals.missedHabitsCount >= 3) {
    recs.push({
      track: 'PARENT',
      title: 'Habits are slipping this week',
      body: `Your child has missed ${signals.missedHabitsCount} habit check-ins recently \u2014 a quick check-in together might help.`,
      reasoningPath: [`missedHabitsCount (${signals.missedHabitsCount}) >= 3`],
    });
  }

  if (signals.healthScore < 40) {
    recs.push({
      track: 'PARENT',
      title: 'Health score is low this week',
      body: 'Hydration, sleep, or activity may need attention \u2014 review the Health tab for specifics.',
      reasoningPath: [`healthScore (${signals.healthScore}) < 40`],
    });
  }

  // Sprint 16.1 Phase 6 -- CLOSES A REAL GAP: education progress was
  // entirely invisible to coaching before this.
  if (signals.educationSessionCount === 0) {
    recs.push({
      track: 'PARENT',
      title: 'No learning sessions logged recently',
      body: 'It might be worth checking in about study time this week.',
      reasoningPath: [`educationSessionCount (${signals.educationSessionCount}) === 0`],
    });
  }

  return recs;
}

export function generateChildCoachRecommendations(signals: ICoachingSignals): ICoachingRecommendation[] {
  const recs: ICoachingRecommendation[] = [];

  if (signals.habitCompletionRate >= 0.8) {
    recs.push({
      track: 'CHILD',
      title: 'You\u2019re doing great!',
      body: 'You\u2019ve been keeping up with your habits really well \u2014 keep it going!',
      reasoningPath: [`habitCompletionRate (${signals.habitCompletionRate}) >= 0.8`],
    });
  }

  // Sprint 16.1 Phase 6 -- CLOSES A REAL GAP: encouraging, non-judgmental
  // education/streak/wellbeing feedback for the child, using the
  // newly-available signals. Deliberately framed positively even for
  // an achieved-goal case -- never a "you failed" message, per the
  // brief's own explicit "non-judgmental" requirement. No rule here
  // ever criticizes a missed goal directly to the child; that stays a
  // PARENT-track concern (see generateParentCoachRecommendations).
  if (signals.educationStreakDays >= 3) {
    recs.push({
      track: 'CHILD',
      title: `${signals.educationStreakDays}-day learning streak!`,
      body: 'Your consistency with studying is really paying off -- keep it up!',
      reasoningPath: [`educationStreakDays (${signals.educationStreakDays}) >= 3`],
    });
  }

  if (signals.hydrationAchievedToday && signals.activityAchievedToday) {
    recs.push({
      track: 'CHILD',
      title: 'Great job today!',
      body: 'You hit both your water and activity goals today -- awesome work!',
      reasoningPath: ['hydrationAchievedToday === true', 'activityAchievedToday === true'],
    });
  }

  return recs;
}

export function generateFamilyCoachRecommendations(signals: ICoachingSignals): ICoachingRecommendation[] {
  const recs: ICoachingRecommendation[] = [];

  if (signals.faithCompletionRate < 0.5) {
    recs.push({
      track: 'FAMILY',
      title: 'A shared challenge idea for this week',
      body: 'Consider a family-wide reading or practice challenge \u2014 shared goals tend to help consistency.',
      reasoningPath: [`faithCompletionRate (${signals.faithCompletionRate}) < 0.5`],
    });
  }

  return recs;
}
