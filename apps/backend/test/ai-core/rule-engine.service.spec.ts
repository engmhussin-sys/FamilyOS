import { RuleEngineService } from '../../src/modules/ai-core/application/services/rule-engine.service';
import type { IKnowledgeSnapshot } from '../../src/modules/ai-core/domain/knowledge.types';

const BASE_SNAPSHOT: IKnowledgeSnapshot = {
  childId: 'child-1',
  familyId: 'family-1',
  ageYears: 10,
  trustLevel: 'L3_ATTESTED',
  riskLevel: 'LOW',
  riskReasons: [],
  dailyLimitMinutes: 90,
  focusModeEnabled: false,
  accessibilityServiceEnabled: true,
  enforcementActive: true,
  recentViolationCount: 0,
};

describe('RuleEngineService', () => {
  const engine = new RuleEngineService();

  it('triggers no rules for a fully healthy snapshot', () => {
    const results = engine.evaluate(BASE_SNAPSHOT);
    expect(results.every((r) => !r.triggered)).toBe(true);
  });

  it('triggers PROTECTION_DISABLED when accessibility is off', () => {
    const results = engine.evaluate({ ...BASE_SNAPSHOT, accessibilityServiceEnabled: false });
    const rule = results.find((r) => r.ruleId === 'PROTECTION_DISABLED');
    expect(rule?.triggered).toBe(true);
    expect(rule?.recommendationType).toBe('RE_ENABLE_PROTECTION');
  });

  it('triggers HIGH_RISK for HIGH and CRITICAL, not for MEDIUM', () => {
    expect(engine.evaluate({ ...BASE_SNAPSHOT, riskLevel: 'HIGH' }).find((r) => r.ruleId === 'HIGH_RISK')?.triggered).toBe(true);
    expect(engine.evaluate({ ...BASE_SNAPSHOT, riskLevel: 'CRITICAL' }).find((r) => r.ruleId === 'HIGH_RISK')?.triggered).toBe(true);
    expect(engine.evaluate({ ...BASE_SNAPSHOT, riskLevel: 'MEDIUM' }).find((r) => r.ruleId === 'HIGH_RISK')?.triggered).toBe(false);
  });

  it('triggers NO_POLICY_SET only when dailyLimitMinutes is null', () => {
    expect(engine.evaluate({ ...BASE_SNAPSHOT, dailyLimitMinutes: null }).find((r) => r.ruleId === 'NO_POLICY_SET')?.triggered).toBe(true);
    expect(engine.evaluate(BASE_SNAPSHOT).find((r) => r.ruleId === 'NO_POLICY_SET')?.triggered).toBe(false);
  });

  it('triggers TRUST_NOT_ESTABLISHED for null, L0, and L1, not for L2+', () => {
    expect(engine.evaluate({ ...BASE_SNAPSHOT, trustLevel: null }).find((r) => r.ruleId === 'TRUST_NOT_ESTABLISHED')?.triggered).toBe(true);
    expect(engine.evaluate({ ...BASE_SNAPSHOT, trustLevel: 'L0_UNKNOWN' }).find((r) => r.ruleId === 'TRUST_NOT_ESTABLISHED')?.triggered).toBe(true);
    expect(engine.evaluate({ ...BASE_SNAPSHOT, trustLevel: 'L1_REGISTERED' }).find((r) => r.ruleId === 'TRUST_NOT_ESTABLISHED')?.triggered).toBe(true);
    expect(engine.evaluate({ ...BASE_SNAPSHOT, trustLevel: 'L2_VERIFIED' }).find((r) => r.ruleId === 'TRUST_NOT_ESTABLISHED')?.triggered).toBe(false);
  });

  it('triggers REPEATED_VIOLATIONS at the 3-violation threshold, not below', () => {
    expect(engine.evaluate({ ...BASE_SNAPSHOT, recentViolationCount: 2 }).find((r) => r.ruleId === 'REPEATED_VIOLATIONS')?.triggered).toBe(false);
    expect(engine.evaluate({ ...BASE_SNAPSHOT, recentViolationCount: 3 }).find((r) => r.ruleId === 'REPEATED_VIOLATIONS')?.triggered).toBe(true);
  });

  it('is a pure function — same input always produces the same output', () => {
    const a = engine.evaluate(BASE_SNAPSHOT);
    const b = engine.evaluate(BASE_SNAPSHOT);
    expect(a).toEqual(b);
  });
});
