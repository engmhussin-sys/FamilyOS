import { VERIFICATION_RANK } from '../../../../shared/rewards/reward-rule-catalogue';
import { IRewardGrant, IRewardRule, IRewardTriggerEvent, LEVEL_XP_THRESHOLDS } from '../../domain/rewards.types';

/**
 * Pure function — zero I/O. This is the "Reward Rules, not just
 * manual coin operations" requirement: automatic, rule-based grants,
 * evaluated the exact same way ai-core's RuleEngineService.evaluate()
 * evaluates its own rule set — a deterministic match against a
 * condition object, never an LLM decision.
 *
 * A rule matches when every key in `triggerCondition` is present and
 * equal in the event's payload — a simple, explainable subset-match,
 * not a rules-engine DSL (deliberately minimal for this sprint).
 *
 * ---------------------------------------------------------------------------
 * B4 EXTENDED THIS FUNCTION RATHER THAN ADDING A SECOND ONE. Three gates were
 * added, in this order, and each one closes a measured defect:
 *
 * 1. EVENT TYPE (PA-B-013). Until B4 a rule matched on `triggerEngine` alone.
 *    `HabitEngineService.completeHabit` fires TWO triggers on the same engine
 *    for one completion — the legacy `habit_completed` (no idempotency key,
 *    kept for backwards compatibility) and the contract `HABIT_COMPLETED`
 *    (keyed). One engine-scoped rule matched BOTH, so connecting the chain
 *    would have paid twice for every habit, and one of the two payments would
 *    have carried `applyEarn`'s `nokey:<uuid>` fallback key, which makes the
 *    unique index vacuous. A rule that names `eventType` matches exactly one.
 *    `eventType == null` is the wildcard and preserves every pre-B4 caller.
 *
 * 2. IDEMPOTENCY KEY. A rule that names its event type is a MANAGED rule, and a
 *    managed rule refuses to pay a trigger that arrives with no key. This is
 *    not belt-and-braces: it means the only way to reintroduce a keyless grant
 *    is to add a keyless event type to `RULE_EVENT_TYPES` in
 *    `shared/rewards/reward-rule-catalogue.ts`, which is a code change under
 *    review, not a configuration change a parent can make.
 *
 * 3. VERIFICATION FLOOR. `CompletionEvent.verifiedBy` already travels in the
 *    payload (`RewardsCompletionConsumer` spreads the whole completion). A rule
 *    may demand `PARENT`, and then a self-asserted completion produces no
 *    grant at all — no ledger row, therefore no `REWARD_GRANTED`, therefore no
 *    notification. "Only after the actual verification condition succeeds",
 *    expressed as data on the rule rather than as a branch per domain.
 * ---------------------------------------------------------------------------
 */
export function evaluateRewardRules(rules: IRewardRule[], event: IRewardTriggerEvent): IRewardGrant[] {
  const grants: IRewardGrant[] = [];

  for (const rule of selectApplicableRules(rules)) {
    if (!rule.isActive || rule.triggerEngine !== event.engine) continue;

    // Gate 1 — event type. `null` is the wildcard (pre-B4 behaviour).
    if (rule.eventType != null && rule.eventType !== event.type) continue;

    // Gate 2 — a typed (managed) rule never pays an unkeyed trigger.
    if (rule.eventType != null && !event.idempotencyKey) continue;

    // Gate 3 — verification floor.
    if (!meetsVerificationFloor(rule, event)) continue;

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

/**
 * THE PRECEDENCE RULE, and the reason platform defaults can be resolved lazily
 * instead of copied into every family.
 *
 * `listActiveRewardRules` returns two tiers in one list: the family's own rules
 * (`family_id = <this family>`) and the platform defaults (`family_id IS NULL`,
 * seeded once by migration 0007). Without precedence a family that configured
 * ONE habit rule would be paid by both tiers and get two rewards per habit —
 * which is exactly what would have happened to the families the existing
 * `event-pipeline.e2e.spec.ts` seeds a hand-written rule for.
 *
 * The rule is deliberately coarse and therefore predictable:
 *
 *   IF A FAMILY HOLDS ANY ACTIVE RULE FOR AN ENGINE, THE PLATFORM DEFAULTS FOR
 *   THAT ENGINE ARE NOT USED AT ALL.
 *
 * "Configuring one rule for an engine is how a family takes ownership of that
 * engine's reward policy." The alternative — per-(engine, eventType) shadowing
 * — produces a mixed tier a parent cannot predict: they would write one habit
 * rule and still be paid by a platform default they never saw, for an event
 * type they never named. Coarse and explicable beats clever and surprising when
 * the output is money-shaped.
 *
 * OPT-OUT IS THE SAME LEVER. Ownership is decided by EXISTENCE, not by
 * `isActive`: a family whose only learning rule is deactivated still owns the
 * learning engine, and therefore earns nothing for learning. That is what a
 * parent who switched their rule off asked for. Had ownership required an
 * active rule, switching your only rule off would have silently handed the
 * engine back to the platform defaults and kept paying — the opposite. The
 * route back to the defaults is `DELETE`ing the rule outright, which the
 * management API exposes separately from deactivation.
 *
 * F4 companion rows are family-owned with `triggerEngine = 'reward-program'`,
 * an engine the platform tier deliberately has no defaults for, so a program
 * neither shadows nor is shadowed by anything.
 */
export function selectApplicableRules(rules: IRewardRule[]): IRewardRule[] {
  const enginesOwnedByFamily = new Set<string>();
  for (const rule of rules) {
    if (rule.familyId !== null) enginesOwnedByFamily.add(rule.triggerEngine);
  }
  if (enginesOwnedByFamily.size === 0) return rules;

  return rules.filter((rule) => rule.familyId !== null || !enginesOwnedByFamily.has(rule.triggerEngine));
}

/**
 * `verifiedBy` is only present on completions that travel the `CompletionEvent`
 * contract. A trigger that carries none is treated as `SELF` — the WEAKEST
 * value, never the strongest — so an unannotated producer can satisfy a rule
 * with no floor and can never satisfy a rule that demands a parent.
 */
export function meetsVerificationFloor(rule: IRewardRule, event: IRewardTriggerEvent): boolean {
  if (!rule.minVerifiedBy) return true;

  const required = VERIFICATION_RANK[rule.minVerifiedBy];
  // Unknown floor: fail OPEN, because the `reward_rules_min_verified_by_known`
  // CHECK constraint already makes the value impossible to store. Failing
  // closed here would silently stop a family's rewards on a data problem the
  // database says cannot exist.
  if (required === undefined) return true;

  const claimed = event.payload.verifiedBy;
  const actual = typeof claimed === 'string' ? VERIFICATION_RANK[claimed] : undefined;
  return (actual ?? VERIFICATION_RANK.SELF) >= required;
}

/** Deterministic level lookup — same discipline as computeHydrationTargetMl. */
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
