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
  it('the schema still has 70 models — the number this classification was built against', () => {
    expect(prismaModels).toHaveLength(70);
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
  it('the strict class is 44 from 0003 + 3 from 0005 + 5 from 0006', () => {
    expect(STRICT_TENANT_MODELS.size).toBe(52);
    expect(SHARED_NULL_TENANT_MODELS.size + PLATFORM_ANNOTATED_MODELS.size).toBe(5);
    expect(SELF_TENANT_MODELS.size).toBe(1);
    expect(GLOBAL_MODELS.size).toBe(12);
  });
});
