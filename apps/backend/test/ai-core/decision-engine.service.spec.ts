import { DecisionEngineService } from '../../src/modules/ai-core/application/services/decision-engine.service';
import { RuleEngineService } from '../../src/modules/ai-core/application/services/rule-engine.service';
import type { IKnowledgeSnapshot } from '../../src/modules/ai-core/domain/knowledge.types';

const HEALTHY_SNAPSHOT: IKnowledgeSnapshot = {
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

describe('DecisionEngineService', () => {
  const engine = new DecisionEngineService(new RuleEngineService());

  it('every field the directive required is present: inputs, rulesApplied, confidence, reasoningPath, recommendation', () => {
    const decision = engine.decide(HEALTHY_SNAPSHOT);
    expect(decision.inputs).toBe(HEALTHY_SNAPSHOT);
    expect(Array.isArray(decision.rulesApplied)).toBe(true);
    expect(typeof decision.confidence).toBe('number');
    expect(Array.isArray(decision.reasoningPath)).toBe(true);
    expect(decision).toHaveProperty('recommendationType');
  });

  it('returns null recommendationType and full confidence for a fully healthy snapshot', () => {
    const decision = engine.decide(HEALTHY_SNAPSHOT);
    expect(decision.recommendationType).toBeNull();
    expect(decision.confidence).toBe(1);
  });

  it('prioritizes PROTECTION_DISABLED over HIGH_RISK when both trigger', () => {
    const decision = engine.decide({
      ...HEALTHY_SNAPSHOT,
      accessibilityServiceEnabled: false,
      riskLevel: 'HIGH',
      riskReasons: ['Emulator detected'],
    });
    expect(decision.recommendationType).toBe('RE_ENABLE_PROTECTION');
  });

  it('reduces confidence when trust/risk are unknown', () => {
    const decision = engine.decide({ ...HEALTHY_SNAPSHOT, trustLevel: null, riskLevel: 'UNKNOWN' });
    expect(decision.confidence).toBeLessThan(1);
    expect(decision.confidence).toBeGreaterThanOrEqual(0.3); // floor
  });

  it('reasoningPath explains every rule, triggered or not', () => {
    const decision = engine.decide(HEALTHY_SNAPSHOT);
    expect(decision.reasoningPath.length).toBeGreaterThanOrEqual(decision.rulesApplied.length);
  });
});
