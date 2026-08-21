/**
 * The classification of all 60 models is only useful if it is TOTAL and
 * MUTUALLY EXCLUSIVE. These tests read Prisma's own model list and the real
 * schema file, so a model added tomorrow cannot be quietly forgotten: it will
 * belong to no class, and the build goes red.
 */
import * as fs from 'fs';
import * as path from 'path';

import { Prisma } from '@prisma/client';

import {
  ALL_CLASSIFIED_MODELS,
  GLOBAL_MODELS,
  PLATFORM_ANNOTATED_MODELS,
  SELF_TENANT_MODELS,
  SHARED_NULL_TENANT_MODELS,
  STRICT_TENANT_MODELS,
} from '../../src/common/tenancy/tenant-model-registry';

const SCHEMA_PATH = path.resolve(__dirname, '../../prisma/schema.prisma');
const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');

function modelBlock(model: string): string {
  const match = schema.match(new RegExp(`^model ${model} \\{([\\s\\S]*?)^\\}`, 'm'));
  if (!match) throw new Error(`model ${model} not found in schema.prisma`);
  return match[1];
}

const prismaModels = Object.values(Prisma.ModelName) as string[];

describe('tenant model registry', () => {
  it('covers every model Prisma knows about — no gaps', () => {
    const unclassified = prismaModels.filter((m) => !ALL_CLASSIFIED_MODELS.has(m));
    expect(unclassified).toEqual([]);
  });

  it('classifies no model that does not exist', () => {
    const ghosts = [...ALL_CLASSIFIED_MODELS].filter((m) => !prismaModels.includes(m));
    expect(ghosts).toEqual([]);
  });

  it('assigns every model to exactly one class', () => {
    const classes = [
      STRICT_TENANT_MODELS,
      SHARED_NULL_TENANT_MODELS,
      PLATFORM_ANNOTATED_MODELS,
      new Set(SELF_TENANT_MODELS.keys()),
      new Set(GLOBAL_MODELS.keys()),
    ];
    const doubles = prismaModels.filter(
      (m) => classes.filter((c) => c.has(m)).length !== 1,
    );
    expect(doubles).toEqual([]);
  });

  // F3 (R3): 60 -> 63 (`DomainEvent`, `OutboxMessage`, `ConsumedMessage`).
  // F4:      63 -> 70. Migration 0006 adds five STRICT tables
  // (`RewardProgram`, `AchievementRequest`, `VerificationAttempt`,
  // `ScreenTimeRewardGrant`, `RewardFulfilment`) and two GLOBAL reference
  // catalogues (`RewardProgramCategory`, `QuranSurah`).
  // Bumping the number here is the intended workflow, not a workaround: a model
  // added WITHOUT touching the registry still fails the two tests above.
  // B5:      70 -> 73. Migration 0008 adds `QuizQuestion` (SHARED_NULL, the
  // server-owned question bank that closes PA-B-017), `QuizAssignment` and
  // `AchievementEvidence` (both STRICT — the second is a recording of a
  // child's voice and STRICT is the only defensible class for it).
  // PHASE C P4: 73 -> 75. Migration 0011 adds `ScheduledJob` (GLOBAL — the job
  // REGISTRY, platform configuration owned by the deployment, exactly the
  // FeatureFlag case) and `JobRun` (PLATFORM_ANNOTATED — a platform-wide sweep
  // has `family_id IS NULL` and must be invisible to tenants, while a
  // family-scoped rollover stamps the household that owns it).
  // PHASE D: 75 -> 85, and the ten are two independent pieces of work landing
  // on the same branch. ONE is the notification deferral (`NotificationDelivery`,
  // migration 0014, STRICT — a notification held until the end of a household's
  // quiet hours belongs to that household and to nobody else). NINE are the
  // commercial subscription and payments domain (migrations 0012-0013). Both
  // are recorded here rather than one of them being folded silently into the
  // other's number, because this census exists precisely so that a model
  // arriving without a classification is a failing test rather than a surprise.
  // PHASE D (GROWTH): 85 -> 98. Migration 0015 adds SIX STRICT tables
  // (`AcquisitionAttribution`, `FamilyActivation`, `ReferralCode`,
  // `ReferralLink`, `ReferralEvent`, `ReferralReward` — each row describes one
  // household and is meaningless outside it), ONE PLATFORM_ANNOTATED
  // (`GrowthAlert` — population-level alerts have `family_id IS NULL` and an
  // AI-safety alert that names a household must not be readable by any tenant)
  // and SIX GLOBAL (`GrowthCampaign`, `CampaignDailySpend`,
  // `GrowthDailyMetric`, `GrowthQuarterlyTarget`, `GrowthForecastScenario`,
  // `GrowthSetting` — platform configuration and cross-tenant aggregates that
  // belong to no household).
  // PHASE F (`F6-002`): 98 -> 100. Migration 0018 adds TWO STRICT tables.
  // `NotificationDecision` is the decision ledger — one row per decision,
  // including the ones that sent nothing, which is the only place a suppression
  // rate can come from. `NotificationPolicySetting` is the per-family caps,
  // cooldowns and quiet hours, which turns `DEFAULT_FATIGUE_POLICY`'s five
  // constants into configuration. Both are one household's business and neither
  // has a tenant-less case.
  // SPRINT F2, migration 0033: 102 -> 103. `AiAlertNote` — an operator's note
  // on one household's safety alert; STRICT, family_id NOT NULL.
  // SPRINT F2, migration 0032: 101 -> 102. `Operator` — see GLOBAL_MODELS below.
  // G16, migration 0021: 100 -> 101. `PilotInvite` is the controlled-pilot
  // allow-list — one row per invited household, created BEFORE that household
  // exists. GLOBAL for a reason of TIMING rather than convenience: the gate runs
  // inside registration, ahead of the transaction that creates the Family row,
  // so a `family_id` column could only ever be NULL at the single moment it is
  // read. The backward link is `redeemed_by_family_id`, and it is indexed. The
  // full argument is in the registry entry itself.
  it('the schema still has 103 models — the number this classification was built against', () => {
    expect(prismaModels).toHaveLength(103);
  });

  it.each([...STRICT_TENANT_MODELS])(
    '%s really carries a NON-NULLABLE familyId in schema.prisma',
    (model) => {
      const block = modelBlock(model);
      expect(block).toMatch(/^\s*familyId\s+String\s+(@unique\s+)?@map\("family_id"\)/m);
      // `String?` would mean the extension's strict filter can be bypassed by
      // a NULL row. Assert the absence explicitly rather than trusting the
      // positive match above.
      expect(block).not.toMatch(/^\s*familyId\s+String\?/m);
    },
  );

  it.each([...SHARED_NULL_TENANT_MODELS, ...PLATFORM_ANNOTATED_MODELS])(
    '%s carries a NULLABLE familyId — deliberately',
    (model) => {
      expect(modelBlock(model)).toMatch(/^\s*familyId\s+String\?\s+@map\("family_id"\)/m);
    },
  );

  it.each([...GLOBAL_MODELS.keys()])('%s carries no familyId and states why', (model) => {
    expect(modelBlock(model)).not.toMatch(/^\s*familyId\s/m);
    expect((GLOBAL_MODELS.get(model) ?? '').length).toBeGreaterThan(40);
  });

  it('every strict tenant model has an index (or unique constraint) starting at familyId', () => {
    // DP-1: "every composite index starts with family_id". A @unique on the
    // column IS an index, so Subscription (one subscription per family) needs
    // no second one.
    const missing = [...STRICT_TENANT_MODELS].filter((m) => {
      const block = modelBlock(m);
      return (
        !/@@index\(\[familyId/.test(block) &&
        !/@@unique\(\[familyId/.test(block) &&
        !/^\s*familyId\s+String\s+@unique/m.test(block)
      );
    });
    expect(missing).toEqual([]);
  });

  // F3: 44 -> 47. The 44 tables migration 0003 left NOT NULL, plus the three
  // event-backbone tables migration 0005 CREATES NOT NULL.
  // F4: 47 -> 52. Five more tables migration 0006 CREATES `family_id NOT NULL`
  // from the first row — no backfill, so no orphan case ever existed for them
  // either. GLOBAL 10 -> 12: the category catalogue and the mushaf, both
  // platform reference data with a written reason in the registry.
  // B5: 52 -> 54, and SHARED_NULL+PLATFORM 5 -> 6. Migration 0008 CREATES
  // `quiz_assignments` and `achievement_evidence` with `family_id NOT NULL`
  // from the first row (no backfill, so no orphan case ever existed for them),
  // and `quiz_questions` NULLABLE on purpose — `family_id IS NULL` is the
  // platform sample bank every family draws from, the same mechanism
  // `RewardRule` has used since Sprint 25. GLOBAL is unchanged at 12: B5 adds
  // no un-tenanted table.
  // PHASE C P4: STRICT is unchanged at 54 — the scheduler adds no strictly
  // tenant-scoped table. SHARED_NULL+PLATFORM 6 -> 7 (`JobRun`) and GLOBAL
  // 12 -> 13 (`ScheduledJob`). Bumping these numbers is the intended workflow:
  // the two tests above still fail for a model added WITHOUT a classification,
  // so the census cannot be satisfied by editing this line alone.
  // PHASE D: STRICT 54 -> 60. ONE of the six is `NotificationDelivery`
  // (migration 0014, CREATED `family_id uuid NOT NULL` — no backfill, so no
  // orphan case ever existed for it); the other five are the commercial
  // payments tables from migration 0013. SHARED_NULL+PLATFORM 7 -> 8 and
  // GLOBAL 13 -> 16 come entirely from that same commercial work — the
  // notification deferral adds no platform-level and no un-tenanted table.
  // PHASE D (GROWTH), migration 0015: STRICT 60 -> 66, SHARED_NULL+PLATFORM
  // 8 -> 9 (`GrowthAlert`), GLOBAL 16 -> 22. The split is argued per table in
  // the registry itself; the headline is that a growth table is STRICT when a
  // row describes ONE household (where it came from, whether it activated, who
  // it referred) and GLOBAL when it is platform configuration or a
  // cross-tenant aggregate that would tell one family about another.
  // PHASE F, migration 0018: STRICT 66 -> 68. Neither new table has a
  // platform-level or un-tenanted case, so the other three classes are
  // unchanged — which is itself the assertion worth making.
  // G16, migration 0021: GLOBAL 22 -> 23 (`PilotInvite`), and the other three
  // classes are UNCHANGED — which is itself the assertion worth making. A
  // controlled pilot adds an operator-owned allow-list, not a new kind of
  // household data: nothing about a family's own rows changes because a pilot
  // exists, and the STRICT count staying at 68 is what says so.
  it('the strict class is 44 from 0003 + 3 from 0005 + 5 from 0006 + 2 from 0008 + 1 from 0014 + 5 from 0013 + 6 from 0015 + 2 from 0018', () => {
    // SPRINT F2, migration 0033: 68 -> 69. `AiAlertNote`.
    expect(STRICT_TENANT_MODELS.size).toBe(69);
    expect(SHARED_NULL_TENANT_MODELS.size + PLATFORM_ANNOTATED_MODELS.size).toBe(9);
    expect(SELF_TENANT_MODELS.size).toBe(1);
    // SPRINT F2, migration 0032: 23 -> 24. `Operator` is platform STAFF —
    // no household, resolved by email before any context exists, and
    // deliberately not `PLATFORM_ANNOTATED` because that class means «may lack
    // a tenant» and this one can never have had one.
    expect(GLOBAL_MODELS.size).toBe(24);
  });
});
