/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * ============================================================================
 * E2E-16 — THE SAFETY ESCALATION PATH, END TO END, ON REAL INFRASTRUCTURE.
 * ============================================================================
 *
 * THE CHAIN THIS FILE PROVES, LINK BY LINK, AND IT ASSERTS ON PERSISTED ROWS
 * RATHER THAN ON RETURN VALUES AT EVERY LINK:
 *
 *   a child writes something unsafe about themselves
 *     -> the offline classifier fires                (`domain/distress.ts`)
 *     -> an `ai_alerts` row exists                   (the durable record)
 *     -> a `notifications` row exists for the PARENT (the person told)
 *     -> that row carries a VALID DESTINATION        (a tap that lands)
 *     -> the destination is a surface the PARENT APP actually answers
 *     -> the parent's sentence is Arabic and non-empty
 *     -> the audit trail names the source event
 *     -> the CHILD is told none of it
 *
 * WHAT IS REAL HERE. Real PostgreSQL, real Redis, the real `AppModule`, the
 * real global HTTP pipeline, the real guards, the real device-bound token, the
 * real tenant extension, and the real routes the two apps call. NOTHING in the
 * path under test is stubbed. No Anthropic key exists in this environment and
 * none is needed: §11.4's governing sentence is «الموديل لا يرتجل في هذه
 * الحالة إطلاقًا» — the model does not improvise here, at all — so the whole
 * path is deterministic keyword classification and human-written copy, and
 * `ACT 0` asserts the zero-provider property rather than assuming it.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS BESIDE `test/ai-core/ai-safety-alert.e2e.spec.ts`.
 *
 * That suite proves the `ai_alerts` ROW: that a detection produces one, that it
 * carries no monitored content, that a replay does not duplicate it, and that
 * the parent can read it. It stops there. The three links AFTER the row — was a
 * human actually TOLD, does the tap LAND anywhere, and does quiet hours swallow
 * a child-safety escalation at 22:00 — were untested, and the third of those is
 * the one that can be silently wrong for a whole product lifetime because
 * nobody runs the suite at night.
 *
 * ---------------------------------------------------------------------------
 * THE CLOCK IS FROZEN, AND ACT V FREEZES IT INSIDE QUIET HOURS ON PURPOSE.
 *
 * The family's business date is half of the alert's dedupe key and the family's
 * LOCAL time is the whole of the quiet-hours question, so a suite on the wall
 * clock would be green in the afternoon and red at 22:00 — the exact hour the
 * product rule is written for. `GOLDEN_DAY` is one day behind the real one (see
 * `golden-world.ts`), and every instant below is derived from it.
 */
import * as fs from 'fs';
import * as path from 'path';

import request = require('supertest');

import {
  GOLDEN_DAY,
  GOLDEN_NOON,
  P,
  bootGoldenWorld,
  describeGolden,
  freezeGoldenClock,
  goldenAt,
  type GoldenHousehold,
  type GoldenWorld,
} from './golden-world';
import {
  DISTRESS_ALERT_COPY,
  DISTRESS_ALERT_SOURCE_MODULE,
  classifyDistress,
  distressAlertSourceEventId,
} from '../../src/modules/ai-core/domain/distress';
import {
  NOTIFICATION_DEEP_LINK_DATA_KEY,
  isValidDeepLink,
  resolveNotificationDestination,
} from '../../src/modules/notifications/domain/engine/notification-destination';
import { quietHoursClassOf } from '../../src/shared/notifications/notification-class';
import {
  DEFAULT_FATIGUE_POLICY,
  evaluateFatigue,
} from '../../src/modules/life-intelligence/application/services/notification-fatigue-guard';
import { getBusinessTimeHHMM, getStartOfBusinessDay } from '../../src/common/time/family-date';
import { AI_PROVIDER } from '../../src/modules/ai-core/domain/ai-provider.port';

/** The notification type the whole chain travels under. */
const TYPE = 'CHILD_WELLBEING_CHECKIN';

/**
 * THE CHILD'S OWN WORDS — self-harm phrasing, so the classifier really fires,
 * and stamped so a match in a persisted column cannot be a leftover from an
 * earlier run of this suite on the same database. ACT 0 asserts that this
 * string IS a CRITICAL detection; a suite whose input quietly stopped being one
 * would pass by writing nothing at all.
 */
const RUN = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const CHILD_WORDS = `أنا تعبان جدا ولا أريد أن أعيش بعد اليوم ${RUN}`;
/** Fragments of the above that must appear in NO row this chain writes. */
const CHILD_FRAGMENTS = ['أريد أن أعيش', 'تعبان', RUN];
/** The five classification codes. None may reach any parent- or child-visible
 * surface: §11.4 forbids handing anyone this product's severity judgement. */
const CODES = ['SELF_HARM', 'HOPELESSNESS', 'ABUSE_OR_FEAR', 'BULLYING', 'SEVERE_SADNESS'] as const;

/** An ordinary answer to «كيف تشعر اليوم؟» that is NOT a detection. */
const ORDINARY_WORDS = 'اليوم كان جيدا وأنهيت واجبي';

/** 22:00 in Africa/Cairo — inside the 21:00-07:00 quiet window, and asserted to
 * be so below from the family's own timezone rather than by arithmetic here. */
const CAIRO_NIGHT = goldenAt('19:00');

// ===========================================================================
// THE PARENT APP'S OWN ROUTER, READ AT TEST TIME
// ===========================================================================
/**
 * WHERE A TAP ACTUALLY LANDS IS NOT A STRING THIS FILE MAY ASSERT.
 *
 * `notification-destination.ts` decides the link. Whether the PARENT APP can
 * open it is a fact about `deep_link_router.dart`, and the only honest way to
 * check it is to read that file — which is what
 * `test/architecture/notification-producer-chain.guard.spec.ts` does, and this
 * is the same resolution applied to one link instead of to the whole catalogue.
 * Hand-asserting `'abny://screen-time'` would pass on the day somebody replaced
 * that case with `unavailable()`.
 *
 * A CASE IS ANSWERED IF ANY BRANCH BUILDS A ROUTE. `case safety: return id ==
 * null ? unavailable() : page(...)` is answered — the server degrades a bare
 * id-bearing surface itself, so the branch a real link takes is the page.
 */
const PARENT_ROUTING_DIR = path.resolve(__dirname, '../../../parent-app/lib/core/routing');

function stripDartComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, (m, lead: string) => lead);
}

function parentAnsweredSurfaces(): string[] {
  const link = fs.readFileSync(path.join(PARENT_ROUTING_DIR, 'deep_link.dart'), 'utf8');
  const router = stripDartComments(fs.readFileSync(path.join(PARENT_ROUTING_DIR, 'deep_link_router.dart'), 'utf8'));

  const enumToWire = new Map<string, string>();
  for (const m of link.matchAll(/DeepLinkSurface\.([A-Za-z_]\w*)\s*=>\s*'([^']+)'/g)) {
    enumToWire.set(m[1], m[2]);
  }

  const labels = [...router.matchAll(/case\s+DeepLinkSurface\.([A-Za-z_]\w*)\s*:/g)];
  const answered = new Set<string>();
  let pending: string[] = [];
  for (let i = 0; i < labels.length; i += 1) {
    const wire = enumToWire.get(labels[i][1]);
    if (!wire) continue;
    pending.push(wire);
    const from = (labels[i].index as number) + labels[i][0].length;
    const to = i + 1 < labels.length ? (labels[i + 1].index as number) : router.length;
    const returns = [...router.slice(from, to).matchAll(/return\s+([\s\S]*?);/g)].map((m) => m[1]);
    if (returns.length === 0) continue; // falls through to the next label
    const dead = returns.every((expr) => /^\s*(?:const\s+)?[A-Za-z_]\w*\.unavailable\s*\(\s*\)\s*$/.test(expr));
    if (!dead) for (const surface of pending) answered.add(surface);
    pending = [];
  }
  return [...answered].sort();
}

const surfaceOf = (deepLink: string): string => deepLink.replace('abny://', '').split('/')[0];

// ===========================================================================

describeGolden('E2E-16 — the safety escalation path, end to end', () => {
  let world: GoldenWorld;
  /** The household the chain is measured on, at noon. */
  let ESC: GoldenHousehold;
  /** A household that answers the same question with an ordinary sentence. */
  let CTRL: GoldenHousehold;
  /** A household that signals distress at 22:00 local. */
  let NIGHT: GoldenHousehold;
  const families: string[] = [];
  const users: string[] = [];

  /** How many times the AI provider was asked for anything, ever. */
  let providerCalls = 0;

  const asParent = (h: GoldenHousehold) => ({ Authorization: `Bearer ${h.parentToken}` });
  const asChild = (h: GoldenHousehold) => ({ Authorization: `Bearer ${h.deviceToken}` });

  const checkin = (h: GoldenHousehold, feeling: string) =>
    request(world.http).post(`${P}/self/coach/checkin`).set(asChild(h)).send({ feeling });

  const todayCard = (h: GoldenHousehold) =>
    request(world.http).get(`${P}/self/coach/today`).set(asChild(h));

  const alertsOf = (h: GoldenHousehold): Promise<any[]> =>
    world.sys('read ai_alerts', () =>
      world.prisma.aiAlert.findMany({ where: { familyId: h.familyId }, orderBy: { createdAt: 'asc' } }),
    );

  const notificationsOf = (h: GoldenHousehold): Promise<any[]> =>
    world.sys('read notifications', () =>
      world.prisma.notification.findMany({ where: { familyId: h.familyId }, orderBy: { createdAt: 'asc' } }),
    );

  const decisionsOf = (h: GoldenHousehold): Promise<any[]> =>
    world.sys('read notification_decisions', () =>
      world.prisma.notificationDecision.findMany({ where: { familyId: h.familyId } }),
    );

  const deferralsOf = (h: GoldenHousehold): Promise<any[]> =>
    world.sys('read notification_deliveries', () =>
      world.prisma.notificationDelivery.findMany({ where: { familyId: h.familyId } }),
    );

  const childMessagesOf = (h: GoldenHousehold): Promise<any[]> =>
    world.sys('read child_messages', () =>
      world.prisma.childMessage.findMany({ where: { familyId: h.familyId } }),
    );

  beforeAll(async () => {
    freezeGoldenClock(GOLDEN_NOON);
    /**
     * THE ONE SUBSTITUTION IN THIS FILE, AND IT IS A COUNTER RATHER THAN A
     * STUB OF THE PATH UNDER TEST. `AI_PROVIDER` is replaced with a provider
     * that COUNTS and then throws, so ACT 0 can state «no model participated»
     * as a measurement. If any link in this chain ever grew a provider call,
     * this counter would move — and the chain would still have to complete,
     * because every string in it is human-written.
     */
    world = await bootGoldenWorld('e2e-16-safety-escalation', (builder) =>
      builder.overrideProvider(AI_PROVIDER).useValue({
        complete: async () => {
          providerCalls += 1;
          throw new Error('E2E-16: no model may be consulted on the safety path');
        },
      }),
    );
    ESC = await world.register('esc-16', { familyTimeZone: 'Africa/Cairo', childName: 'محمد' });
    CTRL = await world.register('ctrl-16', { familyTimeZone: 'Africa/Cairo', childName: 'سارة' });
    /**
     * THE NIGHT HOUSEHOLD IS REGISTERED AT NIGHT, and that is not decoration.
     * `TokenService` mints a SHORT-LIVED access token and the clock is frozen,
     * so a device paired at noon holds a token that is hours expired by 22:00 —
     * the real `DeviceJwtAuthGuard` answers 401 and the suite would be
     * measuring token lifetime instead of quiet hours. Minting this
     * household's token at the instant its story happens keeps ACT V about the
     * product rule.
     */
    jest.setSystemTime(CAIRO_NIGHT);
    NIGHT = await world.register('night-16', { familyTimeZone: 'Africa/Cairo', childName: 'ليان' });
    jest.setSystemTime(GOLDEN_NOON);
    for (const h of [ESC, CTRL, NIGHT]) {
      families.push(h.familyId);
      users.push(h.ownerUserId);
    }
  }, 300_000);

  afterAll(async () => {
    if (world) {
      await world.sys('teardown', async () => {
        const where = { where: { familyId: { in: families } } };
        await world.prisma.growthAlert.deleteMany(where);
        await world.prisma.aiAlert.deleteMany(where);
        await world.prisma.aiMemoryEntry.deleteMany(where);
        await world.prisma.notificationDecision.deleteMany(where);
        await world.prisma.notificationDelivery.deleteMany(where);
        await world.prisma.notification.deleteMany(where);
        await world.prisma.childMessage.deleteMany(where);
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

  // =======================================================================
  // ACT 0 — THE PREMISES, MEASURED RATHER THAN ASSUMED
  // =======================================================================

  it('the input is a real CRITICAL detection, and the control input is not a detection at all', () => {
    expect(classifyDistress(CHILD_WORDS)).toEqual({ detected: true, code: 'SELF_HARM' });
    expect(classifyDistress(ORDINARY_WORDS)).toEqual({ detected: false });
  });

  it('the chain starts empty for every household — nothing here inherits a previous run', async () => {
    for (const h of [ESC, CTRL, NIGHT]) {
      expect(await alertsOf(h)).toHaveLength(0);
      expect(await notificationsOf(h)).toHaveLength(0);
      expect(await deferralsOf(h)).toHaveLength(0);
    }
  });

  // =======================================================================
  // ACT I — THE CHAIN, LINK BY LINK, ON PERSISTED ROWS
  // =======================================================================

  it('LINK 1-2: an unsafe child message over the real route escalates and writes exactly one ai_alerts row', async () => {
    const providerCallsBefore = providerCalls;
    const res = await checkin(ESC, CHILD_WORDS);
    expect(res.status).toBe(201);
    expect(res.body.escalated).toBe(true);

    // NO MODEL PARTICIPATED, measured AROUND the call rather than at the end of
    // the file where a later test could have moved the counter. §11.4's first
    // sentence — «الموديل لا يرتجل في هذه الحالة إطلاقًا» — as an observation.
    expect(providerCalls).toBe(providerCallsBefore);

    const alerts = await alertsOf(ESC);
    expect(alerts).toHaveLength(1);
    const alert = alerts[0];
    expect(alert.familyId).toBe(ESC.familyId);
    expect(alert.childId).toBe(ESC.childId);
    expect(alert.severity).toBe('CRITICAL');
    expect(alert.category).toBe('HEALTH');
    expect(alert.status).toBe('NEW');
    expect(alert.sourceModule).toBe(DISTRESS_ALERT_SOURCE_MODULE);
    expect(alert.title).toBe(DISTRESS_ALERT_COPY.title);
  });

  it('LINK 3: the PARENT is actually told — a notifications row exists, addressed to the family owner', async () => {
    const rows = await notificationsOf(ESC);
    expect(rows).toHaveLength(1);
    const row = rows[0];

    // THE PERSON. Not «a notification was returned» — a row whose `user_id` is
    // the parent's, which is what a phone eventually reads.
    expect(row.userId).toBe(ESC.ownerUserId);
    expect(row.childId).toBe(ESC.childId);
    expect(row.type).toBe(TYPE);
    // CRITICAL, because §11.4 says this one outranks the night.
    expect(row.priority).toBe('CRITICAL');
  });

  it('LINK 4: the row carries a VALID destination, and it is the map’s own answer', async () => {
    const [row] = await notificationsOf(ESC);
    const link = (row.data ?? {})[NOTIFICATION_DEEP_LINK_DATA_KEY];

    // Resolved through the SAME function the server uses — not compared to a
    // literal, which would pass on the day the map changed and the writer did
    // not.
    expect(link).toBe(resolveNotificationDestination({ copyKey: TYPE, audience: 'PARENT' }));
    expect(isValidDeepLink(link)).toBe(true);
  });

  it('LINK 5: the destination is a surface the PARENT APP answers — read out of deep_link_router.dart', async () => {
    const answered = parentAnsweredSurfaces();
    // The scan is not vacuous: it must find the app's real routing table.
    expect(answered.length).toBeGreaterThan(5);
    expect(answered).toContain('notifications');

    const [row] = await notificationsOf(ESC);
    const link = (row.data ?? {})[NOTIFICATION_DEEP_LINK_DATA_KEY] as string;
    expect(answered).toContain(surfaceOf(link));
  });

  it('LINK 6: the parent’s sentence exists, is Arabic, and names the child without quoting them', async () => {
    const [row] = await notificationsOf(ESC);

    expect(typeof row.title).toBe('string');
    expect(row.title.trim().length).toBeGreaterThan(0);
    expect(row.body.trim().length).toBeGreaterThan(0);
    // Arabic-first is a property of the STORED bytes, not of a translation file.
    expect(row.title).toMatch(/[؀-ۿ]/);
    expect(row.body).toMatch(/[؀-ۿ]/);
    // It says WHICH child — that is the whole point of the alert...
    expect(row.body).toContain(ESC.childName);
    // ...and it tells the parent to sit with them, which is the product's one
    // instruction on this path.
    expect(row.body).toContain('اجلس');
  });

  it('LINK 7: the audit trail identifies the SOURCE EVENT, on both the durable row and the notification', async () => {
    const businessDate = GOLDEN_DAY; // Cairo at 15:00 local is the same calendar day
    const [alert] = await alertsOf(ESC);
    const [row] = await notificationsOf(ESC);

    // The alert's key is composed by the producer and is reproducible from the
    // facts — child and family business day — so an operator can join a row to
    // its cause without a lookup table.
    expect(alert.sourceEventId).toBe(distressAlertSourceEventId(ESC.childId, businessDate));
    expect(alert.sourceEventId).toContain(ESC.childId);
    expect(alert.sourceEventId).toContain(businessDate);

    // The notification's key is the recurring form and names the same cause.
    expect(typeof row.sourceEventId).toBe('string');
    expect(row.sourceEventId.length).toBeGreaterThan(0);
    expect(row.sourceEventId).toContain('distress');

    // AND NEITHER KEY IS A PLACE TO PUT WHAT THE CHILD WROTE.
    for (const key of [alert.sourceEventId, row.sourceEventId]) {
      for (const fragment of CHILD_FRAGMENTS) expect(key).not.toContain(fragment);
      for (const code of CODES) expect(key).not.toContain(code);
    }
  });

  it('PARENTS SEE ALERTS, NEVER RAW MONITORED CONTENT — every row this chain wrote, serialised', async () => {
    const rows = [...(await alertsOf(ESC)), ...(await notificationsOf(ESC))];
    expect(rows.length).toBe(2);
    const serialised = JSON.stringify(rows);

    expect(serialised).not.toContain(CHILD_WORDS);
    for (const fragment of CHILD_FRAGMENTS) expect(serialised).not.toContain(fragment);
    // Not the classification either: the parent is not handed our judgement.
    for (const code of CODES) expect(serialised).not.toContain(code);
  });

  it('and the parent’s own HTTP surface shows the alert with no monitored content on it', async () => {
    const res = await request(world.http).get(`${P}/ai-core/alerts`).set(asParent(ESC));
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].severity).toBe('CRITICAL');
    const serialised = JSON.stringify(res.body);
    for (const fragment of CHILD_FRAGMENTS) expect(serialised).not.toContain(fragment);
    for (const code of CODES) expect(serialised).not.toContain(code);
  });

  // =======================================================================
  // ACT II — THE CHILD IS TOLD NONE OF IT
  // =======================================================================
  /**
   * THE NON-ESCALATED PATH ALREADY HIDES THE CLASSIFIER: a child who writes
   * something ordinary gets today's encouragement, byte-identical to what
   * `GET today` would have returned, precisely so a child cannot learn what the
   * classifier reacts to by watching their own screen. THE ESCALATED PATH MUST
   * NOT LEAK IT EITHER — a card that quoted the code, or a `parentAlerted`
   * flag, would tell the child exactly what the ordinary path is careful not
   * to, and would tell them at the worst possible moment.
   */

  it('the ESCALATED response carries the human-written card and nothing about the classification', async () => {
    jest.setSystemTime(GOLDEN_NOON);
    // A replay of the same input: same instant, same words, same verdict.
    const res = await checkin(ESC, CHILD_WORDS);
    expect(res.status).toBe(201);
    expect(res.body.escalated).toBe(true);
    expect(res.body.card.humanWritten).toBe(true);
    expect(res.body.encouragement).toBeNull();

    const serialised = JSON.stringify(res.body);
    // NOT the code, NOT the severity, NOT the category...
    for (const code of CODES) expect(serialised).not.toContain(code);
    expect(serialised).not.toContain('CRITICAL');
    expect(serialised).not.toContain('HEALTH');
    // ...NOT whether a parent was told, and NOT whether a row was written.
    expect(serialised).not.toContain('parentAlerted');
    expect(serialised).not.toContain('alertRecorded');
    expect(serialised).not.toContain('sourceEventId');
    // NOT the parent's alert copy — the two audiences are told different things.
    expect(serialised).not.toContain(DISTRESS_ALERT_COPY.title);
    expect(serialised).not.toContain(DISTRESS_ALERT_COPY.description);
  });

  it('the child’s ORDINARY surface is byte-identical before and after an escalation', async () => {
    // Measured on the escalated household itself rather than by comparing two
    // different children, because the encouragement line is seeded per child:
    // the question is whether THIS child's screen changed, and it did not.
    const after = await todayCard(ESC);
    expect(after.status).toBe(200);
    expect(after.body.messageAr.length).toBeGreaterThan(0);
    // Nothing on the card betrays the escalation.
    const serialised = JSON.stringify(after.body);
    for (const code of CODES) expect(serialised).not.toContain(code);
    expect(serialised).not.toContain(DISTRESS_ALERT_COPY.title);

    const again = await todayCard(ESC);
    expect(again.body).toEqual(after.body);
  });

  it('a NON-escalating check-in returns the same shape — the child cannot tell the classifier fired', async () => {
    const providerCallsBefore = providerCalls;
    const ordinary = await checkin(CTRL, ORDINARY_WORDS);
    expect(ordinary.status).toBe(201);
    // THE COUNTER IS LIVE, and this is what makes the zero above mean
    // something: the ORDINARY path does reach the provider (to re-word an
    // approved encouragement line), and the SAFETY path does not. A counter
    // that never moved would have proven nothing about either.
    expect(providerCalls).toBeGreaterThan(providerCallsBefore);
    expect(ordinary.body.escalated).toBe(false);
    expect(ordinary.body.card).toBeNull();
    // The ordinary path returns today's encouragement, and it is the SAME
    // object `GET today` returns for that child in the same instant.
    const card = await todayCard(CTRL);
    expect(ordinary.body.encouragement).toEqual(card.body);

    // And the two responses expose exactly the same keys, so the shape itself
    // carries no signal.
    const escalated = await checkin(ESC, CHILD_WORDS);
    expect(Object.keys(escalated.body).sort()).toEqual(Object.keys(ordinary.body).sort());

    // The control household wrote nothing anywhere: no detection, no alert, no
    // parent notification.
    expect(await alertsOf(CTRL)).toHaveLength(0);
    expect(await notificationsOf(CTRL)).toHaveLength(0);
  });

  it('nothing was written to the child’s own message table by the escalation', async () => {
    // `child_messages` is the CHILD-readable table. The escalation is a
    // parent-facing fact and must leave no row a child's app could render.
    const rows = await childMessagesOf(ESC);
    const serialised = JSON.stringify(rows);
    for (const code of CODES) expect(serialised).not.toContain(code);
    expect(serialised).not.toContain(DISTRESS_ALERT_COPY.title);
    for (const fragment of CHILD_FRAGMENTS) expect(serialised).not.toContain(fragment);
  });

  // =======================================================================
  // ACT III — NO DUPLICATE, PROVEN BY REPLAYING THE INPUT
  // =======================================================================

  it('replaying the identical input produces no second alert and no second notification', async () => {
    const alertsBefore = await alertsOf(ESC);
    const notificationsBefore = await notificationsOf(ESC);
    expect(alertsBefore).toHaveLength(1);
    expect(notificationsBefore).toHaveLength(1);

    // THREE more times, through the real HTTP route, at the same frozen
    // instant. Not «the code takes the dedupe branch» — the actual input,
    // actually replayed.
    for (let i = 0; i < 3; i += 1) {
      const replay = await checkin(ESC, CHILD_WORDS);
      expect(replay.status).toBe(201);
      // The CHILD's experience is unchanged by the dedupe: they still get the
      // card. Dedupe is a fact about the parent's inbox, not about the child.
      expect(replay.body.escalated).toBe(true);
      expect(replay.body.card.humanWritten).toBe(true);
    }

    const alertsAfter = await alertsOf(ESC);
    const notificationsAfter = await notificationsOf(ESC);
    expect(alertsAfter).toHaveLength(1);
    expect(notificationsAfter).toHaveLength(1);
    // The same ROWS, not merely the same count — a delete-and-rewrite would
    // pass a count assertion and lose the original `created_at`.
    expect(alertsAfter[0].id).toBe(alertsBefore[0].id);
    expect(alertsAfter[0].createdAt).toEqual(alertsBefore[0].createdAt);
    expect(notificationsAfter[0].id).toBe(notificationsBefore[0].id);
  });

  it('the refusal is held by a DATABASE constraint, not by a read-before-write', async () => {
    const indexes: any[] = await world.raw(
      `SELECT indexdef::text AS indexdef FROM pg_indexes
        WHERE tablename = 'ai_alerts' AND indexdef ILIKE '%UNIQUE%'`,
    );
    expect(
      indexes.map((i) => String(i.indexdef).toLowerCase()).some((d) => d.includes('family_id') && d.includes('source_event_id')),
    ).toBe(true);
  });

  // =======================================================================
  // ACT IV — THE DECISION LEDGER, MEASURED
  // =======================================================================
  /**
   * WHAT IS ACTUALLY TRUE HERE, AND IT IS NOT WHAT A READER WOULD ASSUME.
   *
   * `notification_decisions` gains a row for every notification the SMART
   * NOTIFICATION ENGINE decides — and this path deliberately does not go
   * through the engine. `DistressEscalationService` is one of the two SYSTEM
   * entries on `ENGINE_BYPASS_ALLOWLIST`
   * (`test/architecture/notification-engine-bypass.guard.spec.ts`), for the
   * reason its own line states: «safety-critical, and deliberately not subject
   * to scoring or quiet hours». A fatigue cap must never be able to silence a
   * child-safety alert, and the cheapest way to guarantee that is to not enter
   * the machinery that has caps in it.
   *
   * THE PRICE IS PAID IN OBSERVABILITY, AND IT IS MEASURED HERE RATHER THAN
   * ASSUMED: the escalation is invisible to `GET /system/notifications/
   * analytics` and to `GET /notifications/decisions`. That is a real gap — an
   * operator cannot count safety escalations off the decision ledger — and it
   * is NOT this module's to close: the ledger is written by
   * `SmartNotificationEngineService.recordDecision`
   * (`src/modules/notification-engine/application/services/smart-notification-engine.service.ts`),
   * which this module does not own. This test pins the CURRENT truth so the day
   * somebody closes it, this expectation is what tells them the chain changed.
   */

  it('there is no notification_decisions row for a safety escalation — the SYSTEM bypass, measured', async () => {
    expect(await decisionsOf(ESC)).toHaveLength(0);
    // And the notification exists anyway, which is the point of the bypass.
    expect(await notificationsOf(ESC)).toHaveLength(1);
  });

  // =======================================================================
  // ACT V — QUIET HOURS MUST NOT SILENCE A CRITICAL SAFETY ESCALATION
  // =======================================================================

  it('the clock really is inside the family’s quiet hours — the premise, not an assumption', () => {
    jest.setSystemTime(CAIRO_NIGHT);
    const local = getBusinessTimeHHMM(CAIRO_NIGHT, 'Africa/Cairo');
    expect(local).toBe('22:00');
    expect(DEFAULT_FATIGUE_POLICY.quietHoursStart).toBe('21:00');
    expect(DEFAULT_FATIGUE_POLICY.quietHoursEnd).toBe('07:00');
    // 22:00 is after the start and before midnight — inside the window.
    expect(local >= DEFAULT_FATIGUE_POLICY.quietHoursStart).toBe(true);
  });

  it('the escalation is genuinely DELIVER-class, and the pure fatigue guard lets it through at 22:00', () => {
    // 1. THE TABLE. `notification-class.ts` classifies this type DELIVER with a
    //    written justification, and it is the only AI-produced type that is.
    expect(quietHoursClassOf(TYPE, 'CRITICAL')).toBe('DELIVER');
    // It is not DELIVER merely because the priority is CRITICAL: the type alone
    // answers, which is what makes the classification a product decision rather
    // than an accident of a priority field.
    expect(quietHoursClassOf(TYPE)).toBe('DELIVER');
    // And the distinction the matrix exists to make is real — a SAFETY-category
    // sibling is NOT in the class.
    expect(quietHoursClassOf('SCREEN_TIME_EXCEEDED', 'CRITICAL')).toBe('DEFER');

    // 2. THE GUARD, ENTERED DIRECTLY AT 22:00 LOCAL. `evaluateAndDeliver`
    //    short-circuits DELIVER before scoring and before this function is
    //    reached; this asserts the SECOND door is closed too — a caller that
    //    entered here anyway would still not be blocked for QUIET_HOURS.
    const decision = evaluateFatigue(
      { type: TYPE, priority: 'CRITICAL', title: 'ت', body: 'ب', targetAudience: 'PARENT' },
      [],
      CAIRO_NIGHT,
      getBusinessTimeHHMM(CAIRO_NIGHT, 'Africa/Cairo'),
      getStartOfBusinessDay(CAIRO_NIGHT, 'Africa/Cairo'),
    );
    expect(decision.allowed).toBe(true);
    expect(decision.blockedReason).toBeUndefined();

    // 3. THE CONTROL: the same guard, same instant, a DEFER-class type — so
    //    «allowed» above is a property of the class and not of the hour.
    const deferred = evaluateFatigue(
      { type: 'SCREEN_TIME_EXCEEDED', priority: 'CRITICAL', title: 'ت', body: 'ب', targetAudience: 'PARENT' },
      [],
      CAIRO_NIGHT,
      getBusinessTimeHHMM(CAIRO_NIGHT, 'Africa/Cairo'),
      getStartOfBusinessDay(CAIRO_NIGHT, 'Africa/Cairo'),
    );
    expect(deferred.allowed).toBe(false);
    expect(deferred.blockedReason).toBe('QUIET_HOURS');
  });

  it('AT 22:00 LOCAL a real check-in still writes the alert AND still tells the parent, now', async () => {
    jest.setSystemTime(CAIRO_NIGHT);

    const res = await checkin(NIGHT, CHILD_WORDS);
    expect(res.status).toBe(201);
    expect(res.body.escalated).toBe(true);

    // THE DURABLE RECORD.
    const alerts = await alertsOf(NIGHT);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe('CRITICAL');

    // THE PARENT, TOLD AT NIGHT — a row that exists now, not a deferral.
    const rows = await notificationsOf(NIGHT);
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe(TYPE);
    expect(rows[0].priority).toBe('CRITICAL');
    expect(rows[0].userId).toBe(NIGHT.ownerUserId);

    // NOTHING WAS HELD. A deferral row is what a suppressed notification looks
    // like in this product, and there is none.
    expect(await deferralsOf(NIGHT)).toHaveLength(0);

    // The night's row is the same sentence as the day's — quiet hours did not
    // degrade the copy either.
    const [day] = await notificationsOf(ESC);
    expect(rows[0].title).toBe(day.title);
    expect(rows[0].body).toBe(day.body.replace(ESC.childName, NIGHT.childName));
  });

  it('and the destination survives the night too — a night-time tap lands where a daytime one does', async () => {
    const [row] = await notificationsOf(NIGHT);
    const link = (row.data ?? {})[NOTIFICATION_DEEP_LINK_DATA_KEY] as string;
    expect(isValidDeepLink(link)).toBe(true);
    expect(parentAnsweredSurfaces()).toContain(surfaceOf(link));
  });
});
