import { generateSmartTasks } from '../../src/modules/life-intelligence/application/services/smart-task-rules';

describe('generateSmartTasks (pure rule component)', () => {
  const emptyContext = {
    childId: 'c1',
    lateSleepLastNight: false,
    lowHydrationToday: false,
    missedHabitsYesterday: [] as string[],
    screenTimeOverLimit: false,
  };

  it('returns zero suggestions when no signal is triggered', () => {
    expect(generateSmartTasks(emptyContext)).toEqual([]);
  });

  it('suggests exactly 2 tasks for late sleep, both explaining why', () => {
    const result = generateSmartTasks({ ...emptyContext, lateSleepLastNight: true });
    expect(result).toHaveLength(2);
    expect(result.every((t) => t.reason.includes('later than usual'))).toBe(true);
  });

  it('suggests a hydration task when hydration is low', () => {
    const result = generateSmartTasks({ ...emptyContext, lowHydrationToday: true });
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe('health');
  });

  it('suggests a catch-up task naming the specific missed habit', () => {
    const result = generateSmartTasks({ ...emptyContext, missedHabitsYesterday: ['Read a book'] });
    expect(result).toHaveLength(1);
    expect(result[0].title).toContain('Read a book');
    expect(result[0].reason).toContain('Read a book');
  });

  it('suggests 2 tasks (walk + review) when screen time is over the limit', () => {
    const result = generateSmartTasks({ ...emptyContext, screenTimeOverLimit: true });
    expect(result).toHaveLength(2);
    expect(result.map((t) => t.category).sort()).toEqual(['health', 'learning']);
  });

  it('combines multiple signals additively — every rule fires independently', () => {
    const result = generateSmartTasks({
      childId: 'c1',
      lateSleepLastNight: true,
      lowHydrationToday: true,
      missedHabitsYesterday: ['Brush teeth'],
      screenTimeOverLimit: true,
    });
    expect(result).toHaveLength(6);
  });

  it('never crashes and returns an array even with an empty missedHabitsYesterday list', () => {
    const result = generateSmartTasks(emptyContext);
    expect(Array.isArray(result)).toBe(true);
  });
});
