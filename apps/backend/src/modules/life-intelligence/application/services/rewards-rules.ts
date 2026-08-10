import { IRewardGrant, IRewardRule, IRewardTriggerEvent, LEVEL_XP_THRESHOLDS } from '../../domain/rewards.types';

/**
 * Pure function \u2014 zero I/O. This is the "Reward Rules, not just
 * manual coin operations" requirement: automatic, rule-based grants,
 * evaluated the exact same way ai-core's RuleEngineService.evaluate()
 * evaluates its own rule set \u2014 a deterministic match against a
 * condition object, never an LLM decision.
 *
 * A rule matches when every key in `triggerCondition` is present and
 * equal in the event's payload \u2014 a simple, explainable subset-match,
 * not a rules-engine DSL (deliberately minimal for this sprint).
 */
export function evaluateRewardRules(rules: IRewardRule[], event: IRewardTriggerEvent): IRewardGrant[] {
  const grants: IRewardGrant[] = [];

  for (const rule of rules) {
    if (!rule.isActive || rule.triggerEngine !== event.engine) continue;

    const matches = Object.entries(rule.triggerCondition).every(([key, value]) => event.payload[key] === value);
    if (!matches) continue;

    grants.push({
      rewardType: rule.rewardType,
      amountOrBadgeId: rule.rewardAmountOrBadgeId,
      source: `reward_rule:${rule.id}`,
    });
  }

  return grants;
}

/** Deterministic level lookup \u2014 same discipline as computeHydrationTargetMl. */
export function computeLevelFromXp(xp: number): number {
  let level = 1;
  for (let i = 0; i < LEVEL_XP_THRESHOLDS.length; i++) {
    if (xp >= LEVEL_XP_THRESHOLDS[i]) {
      level = i + 1;
    } else {
      break;
    }
  }
  return level;
}
