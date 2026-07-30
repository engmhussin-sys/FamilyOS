import { Injectable } from '@nestjs/common';

import type { IKnowledgeSnapshot } from '../../domain/knowledge.types';

export interface IRuleEvaluation {
  ruleId: string;
  triggered: boolean;
  reason: string;
  recommendationType: string | null;
}

/**
 * Sprint 7's Rule Engine. Every rule is a pure function of
 * `IKnowledgeSnapshot` — no I/O, no LLM call, fully deterministic and
 * testable with plain input/output assertions. This is the mechanism
 * behind "all reasoning... remains inside FamilyOS": these rules
 * produce the SAME output every time for the SAME input, with or
 * without any external provider connected.
 */
@Injectable()
export class RuleEngineService {
  evaluate(snapshot: IKnowledgeSnapshot): IRuleEvaluation[] {
    return [
      this.ruleProtectionDisabled(snapshot),
      this.ruleHighRisk(snapshot),
      this.ruleNoPolicySet(snapshot),
      this.ruleTrustNotEstablished(snapshot),
      this.ruleRepeatedViolations(snapshot),
    ];
  }

  private ruleProtectionDisabled(s: IKnowledgeSnapshot): IRuleEvaluation {
    const triggered = s.accessibilityServiceEnabled === false;
    return {
      ruleId: 'PROTECTION_DISABLED',
      triggered,
      reason: triggered
        ? 'Accessibility Service is disabled — enforcement is not active.'
        : 'Accessibility Service is enabled.',
      recommendationType: triggered ? 'RE_ENABLE_PROTECTION' : null,
    };
  }

  private ruleHighRisk(s: IKnowledgeSnapshot): IRuleEvaluation {
    const triggered = s.riskLevel === 'HIGH' || s.riskLevel === 'CRITICAL';
    return {
      ruleId: 'HIGH_RISK',
      triggered,
      reason: triggered
        ? `Device risk level is ${s.riskLevel}: ${s.riskReasons.join(', ') || 'no specific reasons recorded'}.`
        : `Device risk level is ${s.riskLevel}.`,
      recommendationType: triggered ? 'REVIEW_DEVICE_SECURITY' : null,
    };
  }

  private ruleNoPolicySet(s: IKnowledgeSnapshot): IRuleEvaluation {
    const triggered = s.dailyLimitMinutes === null;
    return {
      ruleId: 'NO_POLICY_SET',
      triggered,
      reason: triggered
        ? 'No daily screen time limit has been configured for this child.'
        : `Daily limit is set to ${s.dailyLimitMinutes} minutes.`,
      recommendationType: triggered ? 'SET_SCREEN_TIME_POLICY' : null,
    };
  }

  private ruleTrustNotEstablished(s: IKnowledgeSnapshot): IRuleEvaluation {
    const triggered = s.trustLevel === null || s.trustLevel === 'L0_UNKNOWN' || s.trustLevel === 'L1_REGISTERED';
    return {
      ruleId: 'TRUST_NOT_ESTABLISHED',
      triggered,
      reason: triggered
        ? `Device trust level is ${s.trustLevel ?? 'not yet established'} — verification is incomplete.`
        : `Device trust level is ${s.trustLevel}.`,
      recommendationType: triggered ? 'COMPLETE_DEVICE_VERIFICATION' : null,
    };
  }

  private ruleRepeatedViolations(s: IKnowledgeSnapshot): IRuleEvaluation {
    // Threshold chosen conservatively — 3+ in 30 days (MemoryEngineService's
    // default lookback) signals a pattern worth a parent's attention,
    // not a single incident.
    const triggered = s.recentViolationCount >= 3;
    return {
      ruleId: 'REPEATED_VIOLATIONS',
      triggered,
      reason: triggered
        ? `${s.recentViolationCount} policy violations recorded in the last 30 days.`
        : `${s.recentViolationCount} policy violations recorded in the last 30 days — within normal range.`,
      recommendationType: triggered ? 'REVIEW_POLICY_EFFECTIVENESS' : null,
    };
  }
}
