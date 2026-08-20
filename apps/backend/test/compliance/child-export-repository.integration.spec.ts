/**
 * THE TWO CONSTRAINTS THAT OUTRANK COMPLETENESS IN A SUBJECT-ACCESS EXPORT,
 * proved against a real PostgreSQL built from prisma/migrations.
 *
 *   (a) IT MUST NOT BECOME A NEW LEAK. Every read in
 *       `PrismaChildExportRepository` names its columns, and no raw Prisma
 *       model reaches the response. Asserted here by SERIALISING THE WHOLE
 *       EXPORT and searching it for the things a raw model would have carried:
 *       the family id, the parent's user id, any row's internal id, an
 *       idempotency key, a device id, and — the one that matters most — the
 *       encrypted latitude/longitude of a location event. The sentinel values
 *       below are recognisable strings, so a leak is a string match rather
 *       than a judgement call.
 *
 *   (b) IT MUST STAY BOUNDED. A family with years of history must not be able
 *       to turn this synchronous, un-streamed GET into an out-of-memory
 *       incident. Asserted by seeding MORE rows than the cap and checking that
 *       the response carries the cap, the TRUE total, and `truncated: true` —
 *       a silent cut would be worse than no export at all.
 *
 * Runs only when INTEGRATION_DATABASE_URL points at a database built from
 * prisma/migrations. Skipped (not silently passed) otherwise.
 */
import { randomUUID } from 'crypto';

import { PrismaChildExportRepository } from '../../src/modules/compliance/infrastructure/repositories/prisma-child-export.repository';
import { createTestPrisma, integrationDatabaseUrl, type TestPrismaHandle } from '../tenancy/prisma-test-client';

const describeIfDb = integrationDatabaseUrl() ? describe : describe.skip;

/** The cap `PrismaChildExportRepository` applies. Seeded past on one category. */
const EXPORT_ROW_LIMIT = 500;

describeIfDb('PrismaChildExportRepository — a real subject-access export (real PostgreSQL)', () => {
  let h: TestPrismaHandle;
  let repository: PrismaChildExportRepository;

  const familyId = randomUUID();
  const otherFamilyId = randomUUID();
  const childId = randomUUID();
  const siblingId = randomUUID();
  const otherFamilyChildId = randomUUID();
  const parentUserId = randomUUID();
  const deviceId = randomUUID();
  const safeZoneId = randomUUID();
  const habitId = randomUUID();

  /** Values that exist ONLY in columns the export must never select. */
  const LEAKED_LATITUDE = 'ENC-LAT-SENTINEL-4b1f';
  const LEAKED_LONGITUDE = 'ENC-LON-SENTINEL-9d2a';
  const LEAKED_IDEMPOTENCY_KEY = 'IDEMPOTENCY-SENTINEL-77c3';
  const SIBLING_SECRET = 'SIBLING-ONLY-MESSAGE-SENTINEL';
  const OTHER_FAMILY_SECRET = 'OTHER-FAMILY-MESSAGE-SENTINEL';

  let records: Awaited<ReturnType<PrismaChildExportRepository['loadRecords']>>;

  beforeAll(async () => {
    h = createTestPrisma();
    repository = new PrismaChildExportRepository(h.raw);

    await h.raw.family.create({ data: { id: familyId, name: 'Export Probe Family' } });
    await h.raw.family.create({ data: { id: otherFamilyId, name: 'Unrelated Family' } });
    await h.raw.user.create({
      data: {
        id: parentUserId,
        email: `export-probe-${parentUserId}@example.invalid`,
        passwordHash: 'not-a-real-hash',
        fullName: 'ولي الأمر',
      },
    });
    for (const [id, fid, name] of [
      [childId, familyId, 'يوسف'],
      [siblingId, familyId, 'سارة'],
      [otherFamilyChildId, otherFamilyId, 'أحمد'],
    ] as const) {
      await h.raw.child.create({
        data: { id, familyId: fid, firstName: name, dateOfBirth: new Date('2016-01-01') },
      });
    }
    await h.raw.device.create({
      data: { id: deviceId, familyId, childId, ownerType: 'CHILD', platform: 'ANDROID', status: 'ACTIVE' },
    });
    await h.raw.locationSafeZone.create({
      data: {
        id: safeZoneId,
        familyId,
        childId,
        name: 'المدرسة',
        zoneType: 'SCHOOL',
        latitude: 30.0444,
        longitude: 31.2357,
        radiusMeters: 200,
      },
    });

    // --- messages: the subject's own, a sibling's, and another family's ---
    await h.raw.childMessage.create({
      data: {
        familyId,
        childId,
        fromUserId: parentUserId,
        authorType: 'PARENT',
        category: 'ENCOURAGEMENT',
        title: 'أحسنت',
        body: 'أحسنت يا يوسف',
      },
    });
    await h.raw.childMessage.create({
      data: {
        familyId,
        childId: siblingId,
        authorType: 'AI',
        category: 'ENCOURAGEMENT',
        title: 'رسالة',
        body: SIBLING_SECRET,
      },
    });
    await h.raw.childMessage.create({
      data: {
        familyId: otherFamilyId,
        childId: otherFamilyChildId,
        authorType: 'AI',
        category: 'ENCOURAGEMENT',
        title: 'رسالة',
        body: OTHER_FAMILY_SECRET,
      },
    });

    // --- rewards: an account, and a ledger whose SUM must survive truncation ---
    await h.raw.rewardsAccount.create({ data: { familyId, childId, xp: 120, coins: 30, stars: 4, level: 3 } });
    await h.raw.rewardsLedgerEntry.create({
      data: {
        familyId,
        childId,
        type: 'EARN',
        rewardType: 'XP',
        amount: 100,
        delta: 100,
        source: 'habit_streak',
        idempotencyKey: LEAKED_IDEMPOTENCY_KEY,
      },
    });
    await h.raw.rewardsLedgerEntry.create({
      data: {
        familyId,
        childId,
        type: 'REDEEM',
        rewardType: 'COINS',
        amount: 20,
        delta: -20,
        source: 'redemption:probe',
        idempotencyKey: `redeem-${randomUUID()}`,
      },
    });

    // --- habits: one definition, and MORE completions than the cap ---
    await h.raw.habit.create({
      data: { id: habitId, familyId, childId, title: 'قراءة القرآن', category: 'FAITH' },
    });
    const completions = Array.from({ length: EXPORT_ROW_LIMIT + 3 }, (_, i) => ({
      familyId,
      habitId,
      childId,
      // `@@unique([habitId, date])` — one completion per habit per day.
      date: new Date(Date.UTC(2024, 0, 1 + i)),
      status: 'COMPLETED',
    }));
    await h.raw.habitCompletion.createMany({ data: completions });

    // --- health + learning: one row each, enough to prove the shape ---
    await h.raw.nutritionLog.create({
      data: { familyId, childId, date: new Date('2026-05-01'), mealType: 'BREAKFAST', items: [], calories: 350 },
    });
    await h.raw.hydrationLog.create({ data: { familyId, childId, amountMl: 250 } });
    await h.raw.sleepLog.create({
      data: {
        familyId,
        childId,
        date: new Date('2026-05-01'),
        sleepStart: new Date('2026-05-01T20:00:00Z'),
        sleepEnd: new Date('2026-05-02T06:00:00Z'),
        quality: 4,
      },
    });
    await h.raw.activityLog.create({
      data: { familyId, childId, date: new Date('2026-05-01'), activityType: 'FOOTBALL', durationMinutes: 45 },
    });
    await h.raw.physicalMeasurementLog.create({
      data: { familyId, childId, date: new Date('2026-05-01'), heightCm: 130, weightKg: 28 },
    });
    await h.raw.healthScoreDaily.create({
      data: { familyId, childId, date: new Date('2026-05-01'), score: 82.5, breakdown: { engine: 'internals' } },
    });
    await h.raw.learningGoal.create({
      data: { familyId, childId, subject: 'school', title: 'الرياضيات' },
    });
    await h.raw.learningSession.create({
      data: { familyId, childId, subject: 'school', durationMinutes: 30, date: new Date('2026-05-01') },
    });
    await h.raw.learningAssessment.create({
      data: { familyId, childId, subject: 'school', scorePercent: 88 },
    });

    // --- location: the category that is summarised, never enumerated ---
    for (const eventType of ['ENTER_ZONE', 'EXIT_ZONE', 'PERIODIC_PING'] as const) {
      await h.raw.locationEvent.create({
        data: {
          familyId,
          childId,
          deviceId,
          safeZoneId: eventType === 'PERIODIC_PING' ? null : safeZoneId,
          eventType,
          latitudeEnc: LEAKED_LATITUDE,
          longitudeEnc: LEAKED_LONGITUDE,
          recordedAt: new Date('2026-05-01T08:00:00Z'),
          expiresAt: new Date('2026-08-01T08:00:00Z'),
        },
      });
    }

    records = await repository.loadRecords(childId);
  }, 60_000);

  afterAll(async () => {
    await h.raw.family.deleteMany({ where: { id: { in: [familyId, otherFamilyId] } } });
    await h.raw.user.deleteMany({ where: { id: parentUserId } });
    await h.disconnect();
  });

  it('exports the categories that were absent — messages, rewards, habits, health, learning, location', () => {
    expect(records.messages.items[0].body).toBe('أحسنت يا يوسف');
    expect(records.rewards.account).toEqual({
      xp: 120,
      coins: 30,
      stars: 4,
      level: 3,
      updatedAt: expect.any(Date),
    });
    expect(records.habits.definitions[0].title).toBe('قراءة القرآن');
    expect(records.health.nutrition.items[0].calories).toBe(350);
    expect(records.health.sleep.items[0].quality).toBe(4);
    expect(records.learning.goals[0].title).toBe('الرياضيات');
    expect(records.learning.assessments.items[0].scorePercent).toBe(88);
    expect(records.location?.totalEvents).toBe(3);
  });

  /** (b) BOUNDED. Seeded 503 completions against a cap of 500. */
  it('caps an enumerated category, states the TRUE total, and flags the truncation', () => {
    expect(records.habits.completions.total).toBe(EXPORT_ROW_LIMIT + 3);
    expect(records.habits.completions.returned).toBe(EXPORT_ROW_LIMIT);
    expect(records.habits.completions.items).toHaveLength(EXPORT_ROW_LIMIT);
    expect(records.habits.completions.truncated).toBe(true);
    expect(records.habits.completions.limit).toBe(EXPORT_ROW_LIMIT);
    // Newest first, so a truncated export keeps the most recent history.
    expect(records.habits.completions.items[0].date.getTime()).toBeGreaterThan(
      records.habits.completions.items[1].date.getTime(),
    );
    // And the habit's title, not its uuid.
    expect(records.habits.completions.items[0].habitTitle).toBe('قراءة القرآن');
  });

  it('an untruncated category says so rather than leaving the reader to guess', () => {
    expect(records.learning.sessions.total).toBe(1);
    expect(records.learning.sessions.truncated).toBe(false);
  });

  it('the ledger balance is summed in SQL over the WHOLE ledger, so truncation cannot make it wrong', () => {
    expect(records.rewards.balancesFromLedger).toEqual({ XP: 100, COINS: -20 });
  });

  it('summarises location instead of enumerating it, and names safe zones without locating them', () => {
    expect(records.location).not.toBeNull();
    expect(records.location?.eventCounts).toEqual({ ENTER_ZONE: 1, EXIT_ZONE: 1, PERIODIC_PING: 1 });
    expect(records.location?.safeZoneNames).toEqual(['المدرسة']);
    expect(records.location?.earliestExpiresAt).toBeInstanceOf(Date);
    expect(records.location).not.toHaveProperty('items');
  });

  /** (a) NOT A NEW LEAK. The whole payload, searched for what a raw model carries. */
  it('never carries an internal identifier, a third party, or an encrypted coordinate', () => {
    const serialised = JSON.stringify(records);

    for (const forbidden of [
      LEAKED_LATITUDE,
      LEAKED_LONGITUDE,
      LEAKED_IDEMPOTENCY_KEY,
      familyId,
      parentUserId,
      deviceId,
      safeZoneId,
      habitId,
      childId,
    ]) {
      expect(serialised).not.toContain(forbidden);
    }
    for (const forbiddenKey of ['familyId', 'fromUserId', 'deviceId', 'safeZoneId', 'idempotencyKey', 'latitudeEnc', 'longitudeEnc', 'breakdown']) {
      expect(serialised).not.toContain(forbiddenKey);
    }
  });

  it('is one data subject: no sibling and no other family appears in it', () => {
    const serialised = JSON.stringify(records);

    expect(serialised).not.toContain(SIBLING_SECRET);
    expect(serialised).not.toContain(OTHER_FAMILY_SECRET);
    expect(records.messages.total).toBe(1);
  });
});
