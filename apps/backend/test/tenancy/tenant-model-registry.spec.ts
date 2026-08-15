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
  it('the schema still has 75 models — the number this classification was built against', () => {
    expect(prismaModels).toHaveLength(75);
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
  it('the strict class is 44 from 0003 + 3 from 0005 + 5 from 0006 + 2 from 0008', () => {
    expect(STRICT_TENANT_MODELS.size).toBe(54);
    expect(SHARED_NULL_TENANT_MODELS.size + PLATFORM_ANNOTATED_MODELS.size).toBe(7);
    expect(SELF_TENANT_MODELS.size).toBe(1);
    expect(GLOBAL_MODELS.size).toBe(13);
  });
});
