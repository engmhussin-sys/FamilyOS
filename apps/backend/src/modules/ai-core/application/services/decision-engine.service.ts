import { Injectable } from '@nestjs/common';

import { RuleEngineService, type IRuleEvaluation } from './rule-engine.service';
import type { IKnowledgeSnapshot } from '../../domain/knowledge.types';

export interface IExplainableDecision {
  childId: string;
  inputs: IKnowledgeSnapshot;
  rulesApplied: IRuleEvaluation[];
  confidence: number;
  reasoningPath: string[];
  recommendationType: string | null;
}

/**
 * Sprint 7's Decision Engine. "Every AI decision must expose: inputs,
 * rules applied, confidence, reasoning path, resulting recommendation.
 * No black-box business logic." — this type IS that requirement; every
 * field the directive named is a field on `IExplainableDecision`, not
 * prose describing a decision that happened somewhere else.
 */
@Injectable()
export class DecisionEngineService {
  constructor(private readonly ruleEngine: RuleEngineService) {}

  decide(snapshot: IKnowledgeSnapshot): IExplainableDecision {
    const rulesApplied = this.ruleEngine.evaluate(snapshot);
    const triggeredRules = rulesApplied.filter((r) => r.triggered);

    const reasoningPath = rulesApplied.map(
      (r) => `[${r.ruleId}] ${r.triggered ? 'TRIGGERED' : 'not triggered'}: ${r.reason}`,
    );

    // Priority order matters when multiple rules trigger — protection
    // being disabled outranks a policy-effectiveness suggestion, since
    // acting on the former makes the latter's data meaningless anyway.
    const priorityOrder = [
      'PROTECTION_DISABLED',
      'TRUST_NOT_ESTABLISHED',
      'HIGH_RISK',
      'NO_POLICY_SET',
      'REPEATED_VIOLATIONS',
    ];
    const topRule = triggeredRules.sort(
      (a, b) => priorityOrder.indexOf(a.ruleId) - priorityOrder.indexOf(b.ruleId),
    )[0];

    reasoningPath.push(
      topRule
        ? `Selected "${topRule.ruleId}" as the top-priority triggered rule.`
        : 'No rules triggered — no recommendation needed.',
    );

    return {
      childId: snapshot.childId,
      inputs: snapshot,
      rulesApplied,
      confidence: this.computeConfidence(snapshot, triggeredRules.length),
      reasoningPath,
      recommendationType: topRule?.recommendationType ?? null,
    };
  }

  /**
   * Confidence reflects DATA COMPLETENESS, not model certainty (there is
   * no model here) — a snapshot with unknown trust/risk has less basis
   * for a confident recommendation than one with every field populated.
   * Deliberately simple and auditable: each missing/unknown field
   * subtracts a fixed amount, floor 0.3 (never claims zero confidence
   * while still returning A recommendation).
   */
  private computeConfidence(snapshot: IKnowledgeSnapshot, triggeredRuleCount: number): number {
    let confidence = 1.0;
    if (snapshot.trustLevel === null) confidence -= 0.2;
    if (snapshot.riskLevel === 'UNKNOWN') confidence -= 0.2;
    if (snapshot.accessibilityServiceEnabled === null) confidence -= 0.15;
    // More simultaneously-triggered rules means more competing signals
    // to disentangle — a mild additional discount, not a cliff.
    if (triggeredRuleCount > 1) confidence -= 0.1 * (triggeredRuleCount - 1);

    return Math.max(0.3, Math.round(confidence * 100) / 100);
  }
}
