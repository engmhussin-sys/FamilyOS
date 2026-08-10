import { IGeneratedSmartTask, ISmartTaskContext } from '../../domain/smart-task.types';

/**
 * Pure function \u2014 zero I/O, fully deterministic. Generates candidate
 * task suggestions from a small, explicit signal snapshot. Business
 * logic remains deterministic; any LLM involvement (not wired this
 * sprint) would only be allowed to reword these titles, never decide
 * which tasks to suggest \u2014 matching this project's AI Freeze
 * discipline for Digital Safety, extended here by the Future-Engine Contract.
 */
export function generateSmartTasks(context: ISmartTaskContext): IGeneratedSmartTask[] {
  const suggestions: IGeneratedSmartTask[] = [];

  if (context.lateSleepLastNight) {
    suggestions.push({ title: 'Wind down 30 minutes earlier tonight', category: 'health', reason: 'Slept later than usual last night' });
    suggestions.push({ title: 'Reduce screen time this evening', category: 'habits', reason: 'Slept later than usual last night' });
  }

  if (context.lowHydrationToday) {
    suggestions.push({ title: 'Drink a glass of water', category: 'health', reason: 'Hydration is below today\u2019s target so far' });
  }

  if (context.missedHabitsYesterday.length > 0) {
    suggestions.push({
      title: `Catch up on: ${context.missedHabitsYesterday[0]}`,
      category: 'habits',
      reason: `Missed "${context.missedHabitsYesterday[0]}" yesterday`,
    });
  }

  if (context.screenTimeOverLimit) {
    suggestions.push({ title: 'Take a 20-minute walk', category: 'health', reason: 'Screen time is over today\u2019s limit' });
    suggestions.push({ title: 'Review a lesson from this week', category: 'learning', reason: 'Screen time is over today\u2019s limit' });
  }

  return suggestions;
}
