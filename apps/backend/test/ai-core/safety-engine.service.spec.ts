import { SafetyEngineService } from '../../src/modules/ai-core/application/services/safety-engine.service';

describe('SafetyEngineService', () => {
  const engine = new SafetyEngineService();

  it('accepts a known-safe recommendation type', () => {
    const result = engine.validate('SET_SCREEN_TIME_POLICY', 'No policy set', 'Consider setting a daily limit.');
    expect(result.isSafe).toBe(true);
  });

  it('rejects an unknown recommendation type', () => {
    const result = engine.validate('DO_SOMETHING_SNEAKY', 'title', 'body');
    expect(result.isSafe).toBe(false);
  });

  it.each([
    'Do this secretly so they never find out.',
    'Install this without them knowing.',
    'Enable hidden monitoring on their phone.',
    'Read their messages without asking.',
  ])('rejects unsafe pattern: "%s"', (unsafeBody) => {
    const result = engine.validate('SET_SCREEN_TIME_POLICY', 'title', unsafeBody);
    expect(result.isSafe).toBe(false);
    expect(result.rejectionReason).not.toBeNull();
  });

  it('accepts null recommendationType (the ALL_CLEAR case)', () => {
    const result = engine.validate(null, 'Everything looks good', 'No issues detected.');
    expect(result.isSafe).toBe(true);
  });

  it('runs with zero external dependencies \u2014 works with no network/provider at all', () => {
    // No mocks, no injected AI provider \u2014 this IS the "no external
    // model required" property, demonstrated structurally: the
    // constructor takes nothing.
    expect(() => new SafetyEngineService()).not.toThrow();
  });
});
