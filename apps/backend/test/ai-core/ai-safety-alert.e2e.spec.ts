/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * ============================================================================
 * THE AI SAFETY ALERT, END TO END — A DETECTION MUST REACH A PARENT.
 * ============================================================================
 *
 * WHAT WAS MEASURED, AND WHY THIS FILE EXISTS.
 *
 * `ai_alerts` is the AI layer's stated output contract — «parents see alerts,
 * never raw monitored content», written above the model in `schema.prisma`. A
 * schema-liveness audit found the table had READERS and NO WRITER:
 * `GrowthAlertsService.aiSafetyIncident` scans it, its own comment says «one is
 * one too many», and it scanned an empty table forever.
 * `test/architecture/dormant-schema.guard.spec.ts` names it in
 * `DORMANT_SCHEMA_DECLARATIONS` for exactly that reason.
 *
 * The consequence is the most serious class of defect this product can have:
 * the offline child-safety classifier (`domain/distress.ts`) could fire, the
 * parent notification could be written, and NO ALERT ROW EXISTED — so the
 * durable, parent-readable, operator-visible record of a child-safety incident
 * was never created and the platform's own «one is one too many» page could
 * never be raised.
 *
 * EVERYTHING BELOW IS DRIVEN THROUGH THE REAL PIPELINE. Real PostgreSQL, real
 * Redis, the real `AppModule`, the real guards, the real tenant extension, the
 * real device token, the real HTTP route the child app calls. Nothing in the
 * path under test is mocked: the only substitution anywhere is the Prisma
 * client's TRANSPORT (the offline WASM engine), which is what every e2e suite
 * in this repository already uses.
 *
 * THE CLOCK IS FROZEN, and one day behind the real one, through
 * `freezeGoldenClock` — the family business date is part of the alert's dedupe
 * key, so a suite that ran on the wall clock would pass by day and fail across
 * local midnight.
 */
import request = require('supertest');

import {
  GOLDEN_NOON,
  P,
  bootGoldenWorld,
  describeGolden,
  freezeGoldenClock,
  type GoldenHousehold,
  type GoldenWorld,
} from '../golden/golden-world';
import { GrowthAlertsService } from '../../src/modules/analytics/application/growth-alerts.service';
import { classifyDistress } from '../../src/modules/ai-core/domain/distress';

/**
 * THE CHILD'S OWN WORDS, and they are the thing this suite hunts for in the
 * persisted row. Unique per run so a match cannot be a leftover from a previous
 * one, and self-harm phrasing so the classifier really fires — asserted below
 * rather than assumed, because a suite whose input silently stopped being a
 * detection would pass by writing nothing.
 */
const RUN = Date.now();
const CHILD_WORDS = `أنا تعبان ولا أريد أن أعيش بعد اليوم ${RUN}`;
/** The fragments of the above that must never appear in any alert column. */
const CHILD_WORD_FRAGMENTS = ['أريد أن أعيش', 'تعبان', String(RUN)];

describeGolden('the AI safety alert reaches a parent (real PostgreSQL, real Redis, real app)', () => {
  let world: GoldenWorld;
  let A: GoldenHousehold;
  let B: GoldenHousehold;
  const families: string[] = [];
  const users: string[] = [];

  const asParent = (h: GoldenHousehold) => ({ Authorization: `Bearer ${h.parentToken}` });
  const asChild = (h: GoldenHousehold) => ({ Authorization: `Bearer ${h.deviceToken}` });

  const alertsOf = (h: GoldenHousehold): Promise<any[]> =>
    world.sys('read ai_alerts', () =>
      world.prisma.aiAlert.findMany({
        where: { familyId: h.familyId },
        orderBy: { createdAt: 'asc' },
      }),
    );

  /** The child app's real check-in call. */
  const checkin = (h: GoldenHousehold, feeling: string) =>
    request(world.http).post(`${P}/self/coach/checkin`).set(asChild(h)).send({ feeling });

  beforeAll(async () => {
    freezeGoldenClock(GOLDEN_NOON);
    world = await bootGoldenWorld('ai-safety-alert');
    A = await world.register('safety-a', { familyTimeZone: 'Africa/Cairo' });
    B = await world.register('safety-b', { familyTimeZone: 'Asia/Riyadh' });
    for (const h of [A, B]) {
      families.push(h.familyId);
      users.push(h.ownerUserId);
    }
  }, 300_000);

  afterAll(async () => {
    if (world) {
      await world.sys('teardown', async () => {
        await world.prisma.growthAlert.deleteMany({ where: { familyId: { in: families } } });
        await world.prisma.aiAlert.deleteMany({ where: { familyId: { in: families } } });
        await world.prisma.aiMemoryEntry.deleteMany({ where: { familyId: { in: families } } });
        await world.prisma.notification.deleteMany({ where: { familyId: { in: families } } });
        await world.prisma.family.deleteMany({ where: { id: { in: families } } });
        await world.prisma.user.deleteMany({ where: { id: { in: users } } });
      });
      await world.close();
    }
    jest.useRealTimers();
  }, 120_000);

  beforeEach(() => {
    jest.setSystemTime(GOLDEN_NOON);
  });

  // =========================================================================
  // ACT I — THE DETECTION PRODUCES A ROW
  // =========================================================================

  it('the input really is a detection — this suite cannot pass by classifying nothing', () => {
    expect(classifyDistress(CHILD_WORDS)).toEqual({ detected: true, code: 'SELF_HARM' });
  });

  it('a real check-in through the real route writes exactly one ai_alerts row', async () => {
    expect(await alertsOf(A)).toHaveLength(0);

    const res = await checkin(A, CHILD_WORDS);
    expect(res.status).toBe(201);
    expect(res.body.escalated).toBe(true);

    const alerts = await alertsOf(A);
    expect(alerts).toHaveLength(1);

    const alert = alerts[0];
    // FAMILY-SCOPED, and the family is the one the DEVICE token carries — never
    // a value the child supplied.
    expect(alert.familyId).toBe(A.familyId);
    expect(alert.childId).toBe(A.childId);
    // THE ENUMS, USED AS THEY WERE MEANT. `aiSafetyIncident` keys on CRITICAL
    // and on `reviewed_at IS NULL`; a row that is neither is a row that rule
    // cannot see.
    expect(alert.severity).toBe('CRITICAL');
    expect(alert.category).toBe('HEALTH');
    expect(alert.status).toBe('NEW');
    expect(alert.reviewedAt).toBeNull();
    expect(alert.reviewedByUserId).toBeNull();
    // The producer names itself, so an operator reading the row knows which
    // subsystem raised it without grepping.
    expect(alert.sourceModule).toBe('ai-core.distress-escalation');
    // Arabic-first copy, and it says something a parent can act on.
    expect(alert.title.length).toBeGreaterThan(0);
    expect(alert.description).toContain('اجلس');
  });

  // =========================================================================
  // ACT II — THE ROW CARRIES NO RAW MONITORED CONTENT
  // =========================================================================

  it('the persisted alert contains none of the child’s words and no classification', async () => {
    const [alert] = await alertsOf(A);
    const serialised = JSON.stringify(alert);

    // 1. NOT THE TEXT, and not any fragment of it.
    expect(serialised).not.toContain(CHILD_WORDS);
    for (const fragment of CHILD_WORD_FRAGMENTS) {
      expect(serialised).not.toContain(fragment);
    }

    // 2. NOT THE CLASSIFICATION. §11.4 is explicit that the parent is not told
    //    which code fired or how serious we judged the words to be, and every
    //    distress code lands on the same title, the same description, the same
    //    severity and the same category — so the row cannot be reverse-read
    //    into a diagnosis either.
    for (const code of ['SELF_HARM', 'HOPELESSNESS', 'ABUSE_OR_FEAR', 'BULLYING', 'SEVERE_SADNESS']) {
      expect(serialised).not.toContain(code);
    }
    for (const clinical of ['اكتئاب', 'انتحار', 'تشخيص', 'مرض']) {
      expect(alert.title + alert.description).not.toContain(clinical);
    }
  });

  it('a DIFFERENT distress code, in another household, produces byte-identical copy', async () => {
    // BULLYING, not SELF_HARM — a genuinely different classification.
    const bullied = 'يتنمرون علي في المدرسة كل يوم';
    expect(classifyDistress(bullied)).toEqual({ detected: true, code: 'BULLYING' });

    const res = await checkin(B, bullied);
    expect(res.status).toBe(201);
    expect(res.body.escalated).toBe(true);

    const [mine] = await alertsOf(A);
    const theirs = await alertsOf(B);
    expect(theirs).toHaveLength(1);
    expect(theirs[0].familyId).toBe(B.familyId);
    expect(theirs[0].childId).toBe(B.childId);

    // THE WHOLE POINT: nothing on the row distinguishes a bullying signal from
    // a self-harm signal. The classification stayed inside the server.
    expect(theirs[0].title).toBe(mine.title);
    expect(theirs[0].description).toBe(mine.description);
    expect(theirs[0].severity).toBe(mine.severity);
    expect(theirs[0].category).toBe(mine.category);
  });

  // =========================================================================
  // ACT III — REPLAY, PROVEN BY REPLAYING
  // =========================================================================

  it('replaying the identical detection produces NO second alert', async () => {
    const before = await alertsOf(A);

    const replay = await checkin(A, CHILD_WORDS);
    expect(replay.status).toBe(201);
    expect(replay.body.escalated).toBe(true);

    const after = await alertsOf(A);
    expect(after).toHaveLength(before.length);
    expect(after.map((a: any) => a.id).sort()).toEqual(before.map((a: any) => a.id).sort());
  });

  it('the refusal is a DATABASE UNIQUE CONSTRAINT, not a code-level check', async () => {
    const columns: any[] = await world.raw(
      `SELECT i.indexname::text AS indexname, i.indexdef::text AS indexdef
         FROM pg_indexes i
        WHERE i.tablename = 'ai_alerts' AND i.indexdef ILIKE '%UNIQUE%'`,
    );
    const definitions = columns.map((c) => String(c.indexdef).toLowerCase());
    expect(
      definitions.some((d) => d.includes('family_id') && d.includes('source_event_id')),
    ).toBe(true);
  });

  // =========================================================================
  // ACT IV — THE PARENT CAN SEE IT, AND ONLY THEIR OWN
  // =========================================================================

  it('a parent reads their own alerts over HTTP', async () => {
    const res = await request(world.http).get(`${P}/ai-core/alerts`).set(asParent(A));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(1);
    for (const item of res.body) {
      expect(item.severity).toBe('CRITICAL');
      expect(item.status).toBe('NEW');
      expect(typeof item.title).toBe('string');
      // The parent is told WHICH CHILD — that is the whole point of an alert —
      // and nothing about what the child wrote.
      expect(typeof item.childFirstName).toBe('string');
      expect(item.childFirstName.length).toBeGreaterThan(0);
    }
    const serialised = JSON.stringify(res.body);
    expect(serialised).not.toContain(CHILD_WORDS);
    for (const fragment of CHILD_WORD_FRAGMENTS) {
      expect(serialised).not.toContain(fragment);
    }
    // The internal dedupe key is not part of the parent's payload.
    expect(serialised).not.toContain('sourceEventId');
  });

  it('family A never sees family B’s alert, and family B never sees family A’s', async () => {
    const a = await request(world.http).get(`${P}/ai-core/alerts`).set(asParent(A));
    const b = await request(world.http).get(`${P}/ai-core/alerts`).set(asParent(B));
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);

    const aBody = JSON.stringify(a.body);
    const bBody = JSON.stringify(b.body);
    for (const identifier of [B.familyId, B.childId, B.ownerUserId]) {
      expect(aBody).not.toContain(identifier);
    }
    for (const identifier of [A.familyId, A.childId, A.ownerUserId]) {
      expect(bBody).not.toContain(identifier);
    }
    expect(b.body).toHaveLength(1);
  });

  it('a CHILD device token cannot read the parent alert surface', async () => {
    const res = await request(world.http).get(`${P}/ai-core/alerts`).set(asChild(A));
    expect(res.status).toBe(401);
  });

  // =========================================================================
  // ACT V — THE READER THAT COULD NEVER FIRE, FIRING
  // =========================================================================

  it('GrowthAlertsService.aiSafetyIncident now raises the incident it was written for', async () => {
    const raised = await world.app.get(GrowthAlertsService).scan(GOLDEN_NOON);
    const safety = raised.filter((r) => r.alertType === 'AI_SAFETY_INCIDENT');
    expect(safety.length).toBeGreaterThanOrEqual(2);

    const scopes = safety.map((s) => s.scopeKey);
    expect(scopes).toContain(A.familyId.slice(0, 8));
    expect(scopes).toContain(B.familyId.slice(0, 8));

    // And the operator's own row names the household without carrying a single
    // detail about the child — `growth_alerts` is platform-annotated and its
    // message says so in Arabic.
    const rows: any[] = await world.sys('read growth_alerts', () =>
      world.prisma.growthAlert.findMany({ where: { familyId: A.familyId } }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].alertType).toBe('AI_SAFETY_INCIDENT');
    expect(rows[0].severity).toBe('CRITICAL');
    expect(JSON.stringify(rows[0])).not.toContain(CHILD_WORDS);
  });
});
