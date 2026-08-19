-- =============================================================================
-- 0030 — THE CHILD WHO WAS PAID TWICE FOR ONE GLASS OF WATER
-- =============================================================================
--
-- THE DEFECT, MEASURED — not inferred — against real PostgreSQL through the
-- Child App's own hydration button
-- (`POST /life-intelligence/self/health/hydration-logs`), with a family that
-- had configured nothing and therefore ran entirely on 0007's platform tier:
--
--   rewards_ledger_entries  EARN  15 XP  source `reward_rule:…0005`
--                                        idem   `daily-goal:hydration:<child>:<day>:XP:reward_rule:…0005`
--                           EARN  15 XP  source `reward_rule:…0003`
--                                        idem   `child:<child>:hydration:<day>:XP:reward_rule:…0003`
--   rewards_accounts.xp     30
--
-- and the same shape on the activity door: 20 + 20, `rewards_accounts.xp = 40`.
-- ONE crossing, TWO payments. The two rules 0007 seeded for that crossing carry
-- IDENTICAL amounts, IDENTICAL caps, IDENTICAL categories and BYTE-IDENTICAL
-- `label_ar`, so the parent's own catalogue screen could not tell them apart
-- either.
--
-- WHY THE DATABASE COULD NOT COLLAPSE IT, which is the load-bearing detail:
-- `rewards_ledger_entries (child_id, idempotency_key)` IS a UNIQUE CONSTRAINT
-- and it did its job — but the key has the GRANTING RULE'S ID appended, so two
-- rule ids are two different keys and two legitimate rows. A duplicate that
-- survives a unique index is not a race the database can win. It has to stop
-- being seeded, and that is what this migration does.
--
-- HOW IT BECAME REACHABLE. `HealthEngineService` had always fired
-- `DAILY_GOAL_COMPLETED {metric: hydration|activity}`. It now ALSO fires the
-- contract names `HYDRATION_GOAL_COMPLETED` / `ACTIVITY_GOAL_COMPLETED`, which
-- is the fix that made 0026's `first_hydration_goal` / `first_activity_goal`
-- badges earnable through the app's own button at all — that fix is correct and
-- is NOT reverted here. It simply revealed that 0007 had seeded a paying rule
-- for BOTH names.
--
-- -----------------------------------------------------------------------------
-- WHAT SURVIVES, AND WHY IT IS THE `*_GOAL_COMPLETED` PAIR
-- -----------------------------------------------------------------------------
--   1. BOTH DOORS EMIT THE SURVIVOR; ONLY ONE EMITS THE RETIREE. The direct app
--      door and `POST /events/batch` both produce `HYDRATION_GOAL_COMPLETED` /
--      `ACTIVITY_GOAL_COMPLETED`, and both compose the key with the SAME
--      `composeIdempotencyKey` call — so the two doors produce a byte-identical
--      key and the ledger's unique constraint refuses the second grant. The
--      retired pair is reachable only from the direct door, on a hand-written
--      key that can never collide with anything.
--   2. THE BADGES NAME THE SURVIVOR. `badge_definitions.criteria` for
--      `first_hydration_goal` / `first_activity_goal` (seeded by 0026) carries
--      `HYDRATION_GOAL_COMPLETED` / `ACTIVITY_GOAL_COMPLETED`. Retiring those
--      would re-break the chain that was just connected.
--   3. NOTHING ELSE CONSUMES `DAILY_GOAL_COMPLETED {metric: …}`. Checked, not
--      assumed: `evaluateRewardRules` matches `trigger_engine` FIRST, and the
--      only other seeded `DAILY_GOAL_COMPLETED` rule is `…000f` on the
--      `habit-builder` engine — which is where `/events/batch` routes that name
--      (`TYPE_SPECS.DAILY_GOAL_COMPLETED.completionKind = 'HABIT'`). Different
--      engine, different trigger, different real-world fact; UNTOUCHED below.
--      The event NAME itself keeps being emitted by `HealthEngineService` and
--      keeps driving `announceDailyGoal` — this retires a REWARD RULE, not an
--      event.
--
-- -----------------------------------------------------------------------------
-- WHAT HAPPENS TO THE LEDGER ROWS EXISTING HOUSEHOLDS ALREADY HOLD
-- -----------------------------------------------------------------------------
-- NOTHING. Deliberately, and this is the whole reason the two rows below are
-- UPDATEd rather than DELETEd:
--
--   * A CHILD'S EARNED HISTORY IS NOT REWRITTEN TO TIDY A CATALOGUE. A household
--     that already banked 30 XP for one crossing keeps those 30 XP. Clawing XP
--     back from a child for a server-side mistake they never made would be a
--     second defect wearing the first one's clothes, and `rewards_accounts.xp`
--     is a reconcilable cache of `SUM(delta)` — silently deleting ledger rows
--     without recomputing it would break that reconciliation too.
--   * THE PROVENANCE STAYS RESOLVABLE. Every row the retired pair ever paid
--     records `source = 'reward_rule:00000000-0000-4b40-8000-00000000000{5,6}'`.
--     There is NO foreign key on that column — it is a provenance string — so
--     deleting the rule would orphan nothing the planner can see and everything
--     a human reading the ledger can. `PrismaRewardsRepository
--     .deactivateRewardRule` already states this doctrine for a parent's own
--     rules («DEACTIVATE, never DELETE. … deleting the rule would orphan the
--     audit trail of every reward it ever paid»); the platform tier gets the
--     same answer.
--   * AND THE NEXT CROSSING PAYS ONCE. `evaluateRewardRules` skips an inactive
--     rule on its FIRST line, so `is_active = false` is a full stop, not a hint.
--     A deactivated PLATFORM row also cannot disturb precedence:
--     `selectApplicableRules` decides engine ownership from `family_id IS NOT
--     NULL` only, so a `family_id IS NULL` row switched off changes nothing for
--     any family.
--
-- IDEMPOTENT AND RE-RUNNABLE, same discipline as 0007 and 0026: the statement
-- is an UPDATE keyed on the two literal ids, so running it twice is running it
-- once. It also asserts nothing about the rows' prior state — a database where
-- 0007 never ran simply matches zero rows.
--
-- SOURCE OF TRUTH: `RETIRED_PLATFORM_RULES` in
-- `src/shared/rewards/reward-rule-catalogue.ts`, and the invariant that keeps
-- this from happening again is `crossingCollisions()` in the same file, checked
-- by `test/rewards/reward-rule-collision.spec.ts` and against these very rows by
-- `test/rewards/reward-rule-connection.e2e.spec.ts`.
-- =============================================================================

UPDATE "reward_rules"
   SET "is_active" = false,
       -- The Arabic label was byte-identical to the surviving rule's, which is
       -- how two rows for one crossing stayed invisible on the parent's own
       -- catalogue screen. A retired row keeps a label that says so.
       "label_ar" = CASE "id"
         WHEN '00000000-0000-4b40-8000-000000000005'
           THEN 'هدف شرب الماء اليومي (قاعدة متقاعدة — استبدلت بقاعدة هدف شرب الماء)'
         WHEN '00000000-0000-4b40-8000-000000000006'
           THEN 'هدف النشاط البدني اليومي (قاعدة متقاعدة — استبدلت بقاعدة هدف النشاط البدني)'
         ELSE "label_ar"
       END,
       "updated_at" = now()
 WHERE "family_id" IS NULL
   AND "id" IN (
     '00000000-0000-4b40-8000-000000000005',  -- health · DAILY_GOAL_COMPLETED {metric: hydration}
     '00000000-0000-4b40-8000-000000000006'   -- health · DAILY_GOAL_COMPLETED {metric: activity}
   )
   AND ("is_active" = true OR "label_ar" NOT LIKE '%قاعدة متقاعدة%');
