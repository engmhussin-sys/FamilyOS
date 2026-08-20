/**
 * ============================================================================
 * ONE CROSSING, ONE PAYMENT — THE INVARIANT, AS A TEST RATHER THAN A COMMENT.
 * ============================================================================
 *
 * WHAT WENT WRONG, MEASURED. `reward-rule-catalogue.ts` has stated since B4 that
 * «the same real-world completion can no longer be paid twice». It was a header
 * comment, and it was true only of the case it was written about — a KEYED
 * contract name beside a KEYLESS legacy one. The case that actually shipped was
 * different and the comment could not see it: ONE producer firing TWO KEYED
 * contract names for ONE crossing, with a seeded platform rule waiting on each.
 *
 * Driven through the Child App's own hydration button against real PostgreSQL,
 * that produced TWO `rewards_ledger_entries` EARN rows of 15 XP for one glass of
 * water and `rewards_accounts.xp = 30`; the activity door produced 20 + 20 and
 * `xp = 40`. `rewards_ledger_entries (child_id, idempotency_key)` is a genuine
 * UNIQUE CONSTRAINT and it could not help: the key carries the granting rule's
 * id, so two rule ids are two different keys and two legitimate rows.
 *
 * WHY THIS FILE IS A PURE SPEC AND NOT AN E2E. The defect is decidable from the
 * catalogue alone — no database, no clock, no app boot — so it should fail in
 * milliseconds in front of whoever adds the rule, not twenty seconds later in an
 * integration suite. The e2e half lives in `reward-rule-connection.e2e.spec.ts`
 * and checks the SEEDED ROWS, because a migration can insert a row this file
 * never mentions.
 *
 * WHAT MAKES IT BITE, and this is the part a header comment could never do:
 * §3 MUTATES the catalogue and proves the check reports the mutation. A guard
 * that has never been seen to fail is a guard nobody has tested.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  PLATFORM_DEFAULT_REWARD_RULES,
  PRODUCER_CROSSINGS,
  RETIRED_PLATFORM_RULES,
  RULE_EVENT_TYPES,
  RewardRuleDefault,
  crossingCollisions,
  crossingTriggers,
  rulesPayingCrossing,
} from '../../src/shared/rewards/reward-rule-catalogue';

/** The tree the source-scanning checks in §2 read. */
const SRC = join(__dirname, '..', '..', 'src');

describe('the seeded reward catalogue can never pay one crossing twice', () => {
  // ==========================================================================
  // 1. THE INVARIANT ITSELF
  // ==========================================================================

  /**
   * THE ASSERTION THIS WHOLE FILE EXISTS FOR. It is written to print the
   * offending rule keys rather than a bare `toHaveLength(0)`, because the next
   * person to trip it needs to know WHICH two rules collided on WHICH crossing —
   * the previous incarnation of this defect took a production measurement to
   * find precisely because nothing named the pair.
   */
  it('1.1 no producer crossing is paid by two rules of the same currency', () => {
    expect(crossingCollisions()).toEqual([]);
  });

  /**
   * THE HYDRATION AND ACTIVITY CROSSINGS, NAMED, because they are the two this
   * defect actually happened on and a general check that passes vacuously would
   * be no check at all. Exactly ONE XP rule and exactly ONE badge rule each — the
   * XP is the payment, the badge is a once-ever identity, and they are not a
   * collision with each other.
   */
  it.each([
    ["a child crosses today's hydration target", 'default:hydration:goal', 'default:badge:first_hydration_goal'],
    ["a child crosses today's 60-minute activity target", 'default:activity:goal', 'default:badge:first_activity_goal'],
  ])('1.2 %s is paid by exactly one XP rule and one badge rule', (name, xpKey, badgeKey) => {
    const crossing = PRODUCER_CROSSINGS.find((c) => c.crossing === name);
    expect(crossing).toBeDefined();

    const paying = rulesPayingCrossing(crossing!);
    expect(paying.map((r) => r.key).sort()).toEqual([badgeKey, xpKey].sort());
    expect(paying.filter((r) => r.rewardType === 'XP')).toHaveLength(1);
  });

  /**
   * THE RETIRED PAIR IS GONE FROM THE CODE COPY. Named by key rather than
   * counted, so re-adding either one under a new key still trips §1.1 while
   * re-adding it under its own key trips here first, with the clearer message.
   */
  it('1.3 the two retired DAILY_GOAL_COMPLETED health rules are not in the catalogue', () => {
    const keys = PLATFORM_DEFAULT_REWARD_RULES.map((r) => r.key);
    for (const retired of RETIRED_PLATFORM_RULES) {
      expect(keys).not.toContain(retired.key);
      // …and the rule that took the work over is still there.
      expect(keys).toContain(retired.supersededByKey);
    }
  });

  /**
   * THE HABIT-BUILDER `DAILY_GOAL_COMPLETED` RULE SURVIVED, and this pins the
   * reason it must: it is a DIFFERENT ENGINE serving a DIFFERENT DOOR. Retiring
   * the health rules by event NAME rather than by (engine, name) would have
   * silently unpaid the device-aggregated daily goal that `POST /events/batch`
   * routes to `habit-builder`.
   */
  it('1.4 the habit-builder DAILY_GOAL_COMPLETED default is untouched', () => {
    const rule = PLATFORM_DEFAULT_REWARD_RULES.find((r) => r.key === 'default:habit:daily-goal');
    expect(rule).toBeDefined();
    expect(rule!.triggerEngine).toBe('habit-builder');
    expect(rule!.eventType).toBe('DAILY_GOAL_COMPLETED');

    // And no HEALTH rule answers that name any more.
    const healthDailyGoal = PLATFORM_DEFAULT_REWARD_RULES.filter(
      (r) => r.triggerEngine === 'health' && r.eventType === 'DAILY_GOAL_COMPLETED',
    );
    expect(healthDailyGoal).toEqual([]);
  });

  // ==========================================================================
  // 2. THE CROSSINGS TABLE IS ABOUT THE REAL PRODUCERS
  // ==========================================================================

  /**
   * A TABLE OF CROSSINGS IS ONLY WORTH ANYTHING IF IT DESCRIBES REALITY. This
   * keeps it from rotting into a list of names that no longer match `src/`:
   * every trigger type is either a member of `RULE_EVENT_TYPES` (a name a
   * managed rule may be written against) or one of the three legacy KEYLESS
   * names deliberately excluded from it. A fourth spelling — a typo, or a
   * contract name invented here — is neither, and fails.
   */
  it('2.1 every listed trigger is a real rule event type or a known keyless legacy name', () => {
    const KEYLESS_LEGACY = ['habit_completed', 'hydration_event', 'practice_logged'];
    for (const crossing of PRODUCER_CROSSINGS) {
      for (const trigger of crossingTriggers(crossing)) {
        const known =
          (RULE_EVENT_TYPES as readonly string[]).includes(trigger.type) ||
          KEYLESS_LEGACY.includes(trigger.type);
        expect({ crossing: crossing.crossing, type: trigger.type, known }).toEqual({
          crossing: crossing.crossing,
          type: trigger.type,
          known: true,
        });
      }
    }
  });

  /**
   * THE KEYLESS NAMES PAY NOTHING, PROVEN RATHER THAN PROMISED. They are listed
   * in the crossings table precisely so this can be asserted: no managed rule
   * can be written against a name that is not in `RULE_EVENT_TYPES`, so the
   * legacy trigger every domain engine still fires for backwards compatibility
   * matches zero rules.
   */
  it('2.2 the legacy keyless triggers match no seeded rule at all', () => {
    for (const crossing of PRODUCER_CROSSINGS) {
      for (const trigger of crossingTriggers(crossing)) {
        if ((RULE_EVENT_TYPES as readonly string[]).includes(trigger.type)) continue;
        const paying = PLATFORM_DEFAULT_REWARD_RULES.filter(
          (r) => r.triggerEngine === crossing.engine && r.eventType === trigger.type,
        );
        expect({ type: trigger.type, paying: paying.map((r) => r.key) }).toEqual({
          type: trigger.type,
          paying: [],
        });
      }
    }
  });

  /**
   * NO CROSSING IS LISTED TWICE. Two entries with the same phrase would split one
   * real-world fact into two, and each half would pass §1.1 on its own while the
   * whole paid twice — the exact shape of the defect, reproduced in the check
   * meant to catch it.
   */
  it('2.3 the crossings table has no duplicate crossing', () => {
    const names = PRODUCER_CROSSINGS.map((c) => c.crossing);
    expect(new Set(names).size).toBe(names.length);
  });

  /**
   * EVERY PRODUCER NAMED IN THE TABLE IS A FILE THAT EXISTS. A crossing whose
   * producer is a stale path is a crossing nobody can check against `src/`, and
   * the whole table then decays into prose.
   */
  it('2.4 every producer names a file that exists in src/', () => {
    const files = new Set<string>();
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (entry.endsWith('.ts')) files.add(entry);
      }
    };
    walk(SRC);

    for (const crossing of PRODUCER_CROSSINGS) {
      for (const producer of crossing.producers) {
        // `file` is `a.ts#method` or `a.ts -> ConsumerName`; only the head is a path.
        const fileName = producer.file.split(/[#\s]/)[0];
        expect({ crossing: crossing.crossing, file: fileName, exists: files.has(fileName) }).toEqual({
          crossing: crossing.crossing,
          file: fileName,
          exists: true,
        });
      }
    }
  });

  /**
   * ===========================================================================
   * 2.5 THE BLIND SPOT ITSELF, AS AN ASSERTION.
   * ===========================================================================
   *
   * WHAT WAS MEASURED. `STREAK_ACHIEVED` has TWO producers —
   * `HabitEngineService.completeHabit` (direct) and `StreakDetectionConsumer`
   * (outbox) — and this table named only the first. It could not, therefore,
   * say the thing that mattered: that one crossing is fired from two files, and
   * that both must compose the SAME idempotency key or the ledger's unique
   * constraint has nothing to catch. It caught nothing: 15 + 15 COINS for one
   * seven-day streak, and 10 + 10 XP for the tick under it, on real PostgreSQL.
   *
   * This is the assertion that keeps the table honest about that, named by
   * crossing rather than counted, so deleting a producer trips it by name.
   */
  it('2.5 the crossings with two doors name BOTH of them', () => {
    const doorsOf = (name: string): string[] => {
      const crossing = PRODUCER_CROSSINGS.find((c) => c.crossing === name);
      expect(crossing).toBeDefined();
      return crossing!.producers.map((p) => `${p.door}:${p.file}`).sort();
    };

    expect(doorsOf('a habit streak milestone is reached')).toEqual([
      'DIRECT:habit-engine.service.ts#completeHabit',
      'OUTBOX:streak-detection.consumer.ts#handle',
    ]);
    expect(doorsOf('a child ticks one habit')).toEqual([
      'DIRECT:habit-engine.service.ts#completeHabit',
      'OUTBOX:event-ingestion.service.ts -> RewardsCompletionConsumer',
    ]);
  });

  /**
   * ===========================================================================
   * 2.6 NO SECOND WAY TO SPELL A STREAK KEY.
   * ===========================================================================
   *
   * The defect was not a typo — it was TWO IMPLEMENTATIONS of one concept, both
   * of which compiled. `composeIdempotencyKey('STREAK_ACHIEVED', …)` is the one
   * home; a hand-written `streak:${childId}:…` template is the retired copy, and
   * a retired copy that still compiles gets called again.
   *
   * This scans `src/` rather than trusting a review, because the whole lesson of
   * this defect is that a reviewer read the direct producer and stopped.
   */
  it('2.6 no file in src/ hand-composes a STREAK_ACHIEVED idempotency key', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (entry.endsWith('.ts')) {
          readFileSync(full, 'utf8')
            .split('\n')
            .forEach((line, i) => {
              // An `idempotencyKey:` ASSIGNMENT whose value begins `streak:` —
              // the exact shape `habit-engine.service.ts` used to write. Prose
              // that quotes the retired shape is left alone on purpose: the
              // comments recording what went wrong must survive this check.
              if (/idempotencyKey:\s*[`'"]streak:/.test(line)) offenders.push(`${full}:${i + 1}`);
            });
        }
      }
    };
    walk(SRC);
    expect(offenders).toEqual([]);
  });

  // ==========================================================================
  // 3. THE GUARD HAS TEETH — PROVEN BY MUTATION
  // ==========================================================================

  /**
   * RE-ADDING THE DEFECT IS DETECTED. This is the retired hydration rule,
   * reconstructed exactly as migration 0007 seeded it, appended to a COPY of the
   * catalogue. If `crossingCollisions` ever stopped seeing it, §1.1 would go on
   * passing while paying a child twice — so this test is what makes §1.1 mean
   * something.
   */
  it('3.1 re-adding the retired hydration rule is reported, with both rule keys', () => {
    const resurrected: RewardRuleDefault = {
      key: 'default:health:daily-goal-hydration',
      triggerEngine: 'health',
      eventType: 'DAILY_GOAL_COMPLETED',
      triggerCondition: { metric: 'hydration' },
      rewardType: 'XP',
      amount: 15,
      maxPerDay: 1,
      maxPerWeek: 7,
      category: 'HEALTH',
      labelAr: 'هدف شرب الماء اليومي',
    };

    const collisions = crossingCollisions([...PLATFORM_DEFAULT_REWARD_RULES, resurrected]);
    expect(collisions).toEqual([
      {
        crossing: "a child crosses today's hydration target",
        // BOTH doors are named, because both of them would pay it.
        producers: [
          'health-engine.service.ts#logHydration',
          'event-ingestion.service.ts -> RewardsCompletionConsumer',
        ],
        paidTwiceAs: 'XP',
        ruleKeys: ['default:health:daily-goal-hydration', 'default:hydration:goal'],
      },
    ]);
  });

  /**
   * A BRAND-NEW RULE ON THE OTHER CONTRACT NAME IS ALSO DETECTED — the version of
   * this defect that has not happened yet. It carries a different key, a
   * different amount and a different label, so nothing about it looks like the
   * pair that was retired; it is caught because it pays the same CROSSING.
   */
  it('3.2 a differently-shaped second XP rule on the same crossing is still reported', () => {
    const wellMeaning: RewardRuleDefault = {
      key: 'default:health:hydration-bonus',
      triggerEngine: 'health',
      eventType: 'HYDRATION_GOAL_COMPLETED',
      triggerCondition: {},
      rewardType: 'XP',
      amount: 5,
      maxPerDay: 1,
      maxPerWeek: 7,
      category: 'HEALTH',
      labelAr: 'مكافأة إضافية للماء',
    };

    const collisions = crossingCollisions([...PLATFORM_DEFAULT_REWARD_RULES, wellMeaning]);
    expect(collisions.map((c) => c.paidTwiceAs)).toEqual(['XP']);
    expect(collisions[0].ruleKeys).toEqual([
      'default:health:hydration-bonus',
      'default:hydration:goal',
    ]);
  });

  /**
   * AND THE SAME BADGE TWICE, which the database would refuse at
   * `child_badge_awards (child_id, badge_id)` — the refusal being a constraint
   * catching a catalogue that should not have asked. Caught here instead.
   */
  it('3.3 two rules awarding the SAME badge on one crossing are reported', () => {
    const duplicateBadge: RewardRuleDefault = {
      key: 'default:badge:first_hydration_goal:copy',
      triggerEngine: 'health',
      eventType: 'HYDRATION_GOAL_COMPLETED',
      triggerCondition: {},
      rewardType: 'BADGE',
      badgeKey: 'first_hydration_goal',
      maxPerDay: null,
      maxPerWeek: null,
      category: 'HEALTH',
      labelAr: 'وسام مكرر',
    };

    const collisions = crossingCollisions([...PLATFORM_DEFAULT_REWARD_RULES, duplicateBadge]);
    expect(collisions.map((c) => c.paidTwiceAs)).toEqual(['badge:first_hydration_goal']);
  });

  /**
   * THE NEGATIVE THAT KEEPS THE GUARD FROM BEING A NUISANCE: an XP rule and a
   * once-ever BADGE rule on one crossing is how EVERY first completion in this
   * product already works, and a check that called that a collision would be
   * deleted within a week. Two currencies for one act is a product decision;
   * two payments in ONE currency is the defect.
   */
  it('3.4 an XP rule beside a COINS rule on one crossing is NOT a collision', () => {
    const coins: RewardRuleDefault = {
      key: 'default:health:hydration-coins',
      triggerEngine: 'health',
      eventType: 'HYDRATION_GOAL_COMPLETED',
      triggerCondition: {},
      rewardType: 'COINS',
      amount: 5,
      maxPerDay: 1,
      maxPerWeek: 7,
      category: 'HEALTH',
      labelAr: 'عملات لهدف الماء',
    };

    expect(crossingCollisions([...PLATFORM_DEFAULT_REWARD_RULES, coins])).toEqual([]);
  });

  /**
   * A RULE WHOSE CONDITION DOES NOT MATCH THE CROSSING IS NOT A COLLISION. The
   * subset-match is the same one `evaluateRewardRules` performs, so a
   * `{metric: 'sleep'}` rule sharing an engine and an event name with the
   * hydration crossing pays nothing and is reported as nothing.
   */
  it('3.5 a rule whose trigger condition does not match the crossing is ignored', () => {
    const otherMetric: RewardRuleDefault = {
      key: 'default:health:sleep-goal',
      triggerEngine: 'health',
      eventType: 'HYDRATION_GOAL_COMPLETED',
      triggerCondition: { metric: 'sleep' },
      rewardType: 'XP',
      amount: 15,
      maxPerDay: 1,
      maxPerWeek: 7,
      category: 'HEALTH',
      labelAr: 'هدف النوم',
    };

    expect(crossingCollisions([...PLATFORM_DEFAULT_REWARD_RULES, otherMetric])).toEqual([]);
  });
});
