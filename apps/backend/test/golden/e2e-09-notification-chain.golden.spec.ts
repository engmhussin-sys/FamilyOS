/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * ============================================================================
 * GOLDEN E2E-09 — THE CHAIN, AS ONE CONNECTED THING. AND IT ONLY HAPPENS ONCE.
 * ============================================================================
 *
 * WHAT THE EIGHT SCENARIOS BEFORE THIS ONE DO NOT DO. Each of them asserts a
 * COUNT at the end of the loop: one ledger row, one notification, one child
 * message. A count is the right assertion for «did the product work», and it is
 * the wrong assertion for «is this the SAME notification the event asked for».
 * Six tables can each hold exactly one row and describe six unrelated things —
 * and the two defects this codebase has recorded on this path (`PE-N-001`,
 * `PF-E-006`) both looked exactly like that: every layer reporting success,
 * every count plausible, the connection missing.
 *
 * SO THIS FILE ASSERTS THE EDGES, NOT THE NODES. One reward, earned by a child
 * on a real device over real HTTP, and then every hop is walked with the ID the
 * previous hop wrote:
 *
 *   domain_events.id
 *     -> outbox_messages.domain_event_id      (PUBLISHED, one row)
 *     -> consumed_messages.domain_event_id    (the consumer ran, exactly once)
 *     -> notification_decisions.source_event_id = `evt:{domain_events.id}`
 *     -> notifications.source_event_id        = the SAME key, same family,
 *                                               same child, and the recipient
 *                                               is the family OWNER
 *     -> child_messages.source_event_id       = the same key + `:child`
 *     -> notification_deliveries              THE DELIVERY ATTEMPT — a durable
 *                                               row with an attempt counter,
 *                                               which is the only place this
 *                                               system records an attempt at
 *                                               all (ACT III).
 *
 * `evt:{id}` is not restated here as a literal — it is composed by
 * `forDomainEvent`, the producer's own function, so a change to the key format
 * moves this test rather than breaking it dishonestly.
 *
 * ACT II — IDEMPOTENCY, AND IT IS THE REAL FAILURE MODE, not a synthetic one.
 * The outbox is at-least-once by construction: a relay that publishes and then
 * crashes before marking the row re-publishes it. So the SAME domain event is
 * put back on the outbox and drained again, and the requirement is not «about
 * one row» — it is ZERO ADDITIONAL rows in all four tables, with the second
 * consumption resolved by `consumed_messages`, `notification_decisions_cause_uniq`,
 * `notifications (family_id, source_event_id, user_id)` and
 * `child_messages (family_id, source_event_id)`. Four independent constraints
 * and no reliance on any of them being the one that fires.
 *
 * ACT III — G9, QUIET HOURS: DEFERRED, THEN RELEASED, EXACTLY ONCE. A reward
 * earned at 23:30 Cairo time is not announced at 23:30. It becomes a
 * `notification_deliveries` row scheduled for 07:00 LOCAL, and the 07:00 sweep
 * turns it into exactly one `notifications` row. A SECOND sweep produces
 * nothing — `PC-D-005` was the defect where `DEFER` was a word that wrote no
 * row, and the opposite defect (a sweep that re-releases) would be worse,
 * because it arrives as a flood rather than as silence.
 *
 * Real PostgreSQL, real Redis, real booted app, real HTTP. Nothing stubbed.
 */
import {
  P,
  ageTheHousehold,
  asChild,
  asParent,
  bootGoldenWorld,
  describeGolden,
  freezeGoldenClock,
  goldenAt,
  type GoldenHousehold,
  type GoldenWorld,
} from './golden-world';
import { QuietHoursReleaseService } from '../../src/modules/life-intelligence/application/services/quiet-hours-release.service';
import { forDomainEvent } from '../../src/shared/notifications/notification-source-key';
import { getBusinessTimeHHMM } from '../../src/common/time/family-date';

import request = require('supertest');

const CAIRO = 'Africa/Cairo';

/**
 * THE UTC INSTANT AT WHICH CAIRO'S CLOCK READS `hhmm` — SEARCHED, NOT ASSUMED.
 *
 * The first draft of ACT III wrote `goldenAt('21:30')` with a comment saying
 * «Cairo is UTC+2 in January». The golden day is DERIVED FROM THE REAL CLOCK
 * (`Date.now() - 24h`), so in August Cairo is UTC+3 and 21:30Z is 00:30 local —
 * the wrong side of midnight, a different business day, and a scenario that
 * would have been green for four months a year. A quiet-hours test that hard-codes
 * an offset is testing the tester's arithmetic.
 *
 * So the instant is found by asking the PRODUCTION function
 * `getBusinessTimeHHMM` — the same one `evaluateAndDeliver` uses to decide the
 * window — which makes the premise true by construction in any zone, in any
 * month, across a DST boundary.
 */
function utcWhenLocalIs(hhmm: string, timeZone: string, dayOffset = 0): Date {
  const base = goldenAt('00:00').getTime() + dayOffset * 24 * 60 * 60 * 1000;
  for (let minutes = -24 * 60; minutes < 48 * 60; minutes += 5) {
    const candidate = new Date(base + minutes * 60 * 1000);
    if (getBusinessTimeHHMM(candidate, timeZone) === hhmm) return candidate;
  }
  throw new Error(`no instant near the golden day has local time ${hhmm} in ${timeZone}`);
}

describeGolden('GOLDEN E2E-09 — the notification chain, its idempotency, and the night it waited out', () => {
  let world: GoldenWorld;
  /** ACT I + II: a household at midday, so nothing is deferred. */
  let day: GoldenHousehold;
  /** ACT III: its own household, so the night's arithmetic is not ACT I's. */
  let night: GoldenHousehold;
  let release: QuietHoursReleaseService;

  beforeAll(async () => {
    freezeGoldenClock(goldenAt('10:00'));
    world = await bootGoldenWorld('golden E2E-09 (notification chain)');
    const year = Number(goldenAt('10:00').toISOString().slice(0, 4));
    day = await world.register('e2e09day', {
      childName: 'محمد',
      childDateOfBirth: `${year - 12}-04-01`,
      familyTimeZone: CAIRO,
    });
    night = await world.register('e2e09night', {
      childName: 'سلمى',
      childDateOfBirth: `${year - 12}-04-01`,
      familyTimeZone: CAIRO,
    });
    await ageTheHousehold(world, day, goldenAt('06:00'));
    await ageTheHousehold(world, night, goldenAt('06:00'));
    release = world.app.get(QuietHoursReleaseService);
  }, 240_000);

  afterAll(async () => {
    jest.useRealTimers();
    if (world) await world.close();
  });

  // ---------------------------------------------------------------- helpers

  const rows = (sql: string, ...params: unknown[]): Promise<any[]> => world.raw<any[]>(sql, ...params);

  const domainEvents = (h: GoldenHousehold, eventType: string) =>
    rows(
      `SELECT * FROM "domain_events" WHERE "family_id" = $1::uuid AND "event_type"::text = $2
         ORDER BY "occurred_at", "id"`,
      h.familyId,
      eventType,
    );

  const outboxFor = (domainEventId: string) =>
    rows(`SELECT * FROM "outbox_messages" WHERE "domain_event_id" = $1::uuid`, domainEventId);

  const consumedFor = (domainEventId: string) =>
    rows(`SELECT * FROM "consumed_messages" WHERE "domain_event_id" = $1::uuid ORDER BY "consumer_name"`, domainEventId);

  const decisionsFor = (h: GoldenHousehold, sourceEventId: string) =>
    rows(
      `SELECT * FROM "notification_decisions"
         WHERE "family_id" = $1::uuid AND "source_event_id" = $2
         ORDER BY "target_audience"`,
      h.familyId,
      sourceEventId,
    );

  const notificationsFor = (h: GoldenHousehold, sourceEventId: string) =>
    rows(
      `SELECT * FROM "notifications" WHERE "family_id" = $1::uuid AND "source_event_id" = $2`,
      h.familyId,
      sourceEventId,
    );

  const childMessagesFor = (h: GoldenHousehold, sourceEventId: string) =>
    rows(
      `SELECT * FROM "child_messages" WHERE "family_id" = $1::uuid AND "source_event_id" = $2`,
      h.familyId,
      sourceEventId,
    );

  const deliveriesFor = (h: GoldenHousehold) =>
    rows(
      `SELECT * FROM "notification_deliveries" WHERE "family_id" = $1::uuid ORDER BY "created_at", "id"`,
      h.familyId,
    );

  interface ChainCounts {
    readonly outbox: number;
    readonly decisions: number;
    readonly notifications: number;
    readonly childMessages: number;
  }

  /**
   * THE RECORDS THAT EXIST BECAUSE OF THIS ONE CAUSE, counted together so
   * «zero additional» is ONE comparison rather than four that can drift apart.
   *
   * SCOPED TO THE CAUSE, not to the family, and the first draft got this wrong:
   * a family-wide `outbox_messages` count is FIVE after this loop, because
   * creating a child, creating a program, starting and verifying an achievement
   * and granting the reward are all real domain events. Counting them as
   * «notification records» would have made the number meaningless in both
   * directions.
   */
  const countCause = async (
    h: GoldenHousehold,
    domainEventId: string,
    sourceEventId: string,
  ): Promise<ChainCounts> => ({
    outbox: (await outboxFor(domainEventId)).length,
    decisions: (await decisionsFor(h, sourceEventId)).length,
    notifications: (await notificationsFor(h, sourceEventId)).length,
    childMessages: (await childMessagesFor(h, `${sourceEventId}:child`)).length,
  });

  /**
   * AND THE FAMILY-WIDE TOTALS TOO, because the cause-scoped count above cannot
   * see a duplicate written under a DIFFERENT key — which is exactly what a
   * broken idempotency key would produce, and exactly the failure that would
   * otherwise pass ACT II with full marks.
   */
  const countFamily = async (h: GoldenHousehold): Promise<ChainCounts> => {
    const one = async (sql: string): Promise<number> => Number((await rows(sql, h.familyId))[0].n);
    return {
      outbox: await one(
        `SELECT COUNT(*)::int AS n FROM "outbox_messages" WHERE "family_id" = $1::uuid AND "event_type"::text = 'REWARD_GRANTED'`,
      ),
      decisions: await one(`SELECT COUNT(*)::int AS n FROM "notification_decisions" WHERE "family_id" = $1::uuid`),
      notifications: await one(`SELECT COUNT(*)::int AS n FROM "notifications" WHERE "family_id" = $1::uuid`),
      childMessages: await one(`SELECT COUNT(*)::int AS n FROM "child_messages" WHERE "family_id" = $1::uuid`),
    };
  };

  /** The real product loop: a parent creates a program, the child earns it on
   * their own device. Six HTTP calls, no engine call, no double. */
  async function earnAReward(h: GoldenHousehold, unit: string): Promise<void> {
    const program = await request(world.http)
      .post(`${P}/reward-programs`)
      .set(asParent(h))
      .send({
        childId: h.childId,
        category: 'HOUSEWORK',
        activity: 'CHORE',
        targetSpec: { quantity: 1, unit },
        durationMinutes: 10,
        verificationLevel: 'SELF_CHECK',
        rewardSpec: { type: 'POINTS', amount: 10 },
      });
    expect([200, 201]).toContain(program.status);

    const started = await request(world.http)
      .post(`${P}/self/achievements/start`)
      .set(asChild(h))
      .send({ programId: program.body.id });
    expect([200, 201]).toContain(started.status);

    const submitted = await request(world.http)
      .post(`${P}/self/achievements/${started.body.id}/submit`)
      .set(asChild(h))
      .send({ selfConfirmed: true });
    expect(submitted.body.status).toBe('VERIFIED');
  }

  // =========================================================================
  // ACT I — THE CHAIN
  // =========================================================================

  describe('ACT I — one event, walked hop by hop with the id the previous hop wrote', () => {
    let domainEventId: string;
    let sourceEventId: string;

    it('the product loop runs over real HTTP and the outbox drains cleanly', async () => {
      await earnAReward(day, 'مهمة');
      const drain = await world.drainOutbox();
      expect(drain.failed).toBe(0);
      expect(drain.published).toBeGreaterThan(0);
    });

    it('HOP 1 — the reward produced exactly ONE `REWARD_GRANTED` domain event, for this child', async () => {
      const events = await domainEvents(day, 'REWARD_GRANTED');
      expect(events).toHaveLength(1);
      expect(events[0].child_id).toBe(day.childId);
      expect(events[0].family_id).toBe(day.familyId);
      domainEventId = events[0].id;
      // The key every downstream table is keyed on, composed by the PRODUCER's
      // own function rather than restated as a literal here.
      sourceEventId = forDomainEvent(domainEventId);
    });

    it('HOP 2 — ONE outbox row carries that exact `domain_event_id`, and it is PUBLISHED', async () => {
      const outbox = await outboxFor(domainEventId);
      expect(outbox).toHaveLength(1);
      expect(outbox[0].status).toBe('PUBLISHED');
      expect(outbox[0].published_at).not.toBeNull();
      expect(outbox[0].family_id).toBe(day.familyId);
      expect(outbox[0].event_type).toBe('REWARD_GRANTED');
    });

    it('HOP 3 — the notification consumer recorded consuming THAT event, exactly once', async () => {
      const consumed = await consumedFor(domainEventId);
      const notificationConsumer = consumed.filter((c) =>
        String(c.consumer_name).toLowerCase().includes('notification'),
      );
      expect(notificationConsumer).toHaveLength(1);
      expect(notificationConsumer[0].outcome).toBe('HANDLED');
      expect(notificationConsumer[0].family_id).toBe(day.familyId);
    });

    it('HOP 4 — TWO decision rows carry `evt:{that id}` — one per audience, each with its own arithmetic', async () => {
      const decisions = await decisionsFor(day, sourceEventId);
      // Two audiences, two separately scored decisions: `F6-006`'s reason for
      // two `handleEvent` calls rather than one flag.
      expect(decisions.map((d) => d.target_audience)).toEqual(['CHILD', 'PARENT']);
      for (const d of decisions) {
        expect(d.source_event_id).toBe(sourceEventId);
        expect(d.family_id).toBe(day.familyId);
        expect(d.child_id).toBe(day.childId);
        expect(d.trigger).toBe('DOMAIN_EVENT');
        // A decision row exists even when nothing was sent; here both sent, and
        // the OUTCOME is the field that says the pipeline agreed with the
        // decision rather than silently disagreeing.
        expect(`${d.target_audience}:${d.decision}`).toBe(`${d.target_audience}:SEND`);
        expect(`${d.target_audience}:${d.outcome}`).toBe(`${d.target_audience}:SEND`);
      }
    });

    it('HOP 5 — the PARENT notification row carries the SAME key, and goes to the family OWNER', async () => {
      const notifications = await notificationsFor(day, sourceEventId);
      expect(notifications).toHaveLength(1);
      const [notification] = notifications;
      expect(notification.source_event_id).toBe(sourceEventId);
      expect(notification.family_id).toBe(day.familyId);
      expect(notification.child_id).toBe(day.childId);
      // The recipient is not asserted as «some user» — it is THE OWNER, read
      // from `family_members` rather than from the notification itself.
      const owner = await rows(
        `SELECT "user_id" FROM "family_members" WHERE "family_id" = $1::uuid AND "role" = 'OWNER' AND "deleted_at" IS NULL`,
        day.familyId,
      );
      expect(owner).toHaveLength(1);
      expect(notification.user_id).toBe(owner[0].user_id);
      expect(notification.user_id).toBe(day.ownerUserId);
    });

    it('HOP 6 — the CHILD message carries the same key plus the `:child` facet, PENDING behind the approval gate', async () => {
      const childKey = `${sourceEventId}:child`;
      const messages = await childMessagesFor(day, childKey);
      expect(messages).toHaveLength(1);
      const [message] = messages;
      expect(message.child_id).toBe(day.childId);
      expect(message.author_type).toBe('AI');
      expect(message.approval_status).toBe('PENDING');
      expect(message.delivered_at).toBeNull();
      // The facet is what stops the child's row and the parent's row from
      // colliding on one cause — asserted as a relationship, not two literals.
      expect(message.source_event_id.startsWith(sourceEventId)).toBe(true);
      expect(message.source_event_id).not.toBe(sourceEventId);
    });

    it('THE WHOLE CHAIN, RESTATED AS ONE ASSERTION — every hop reachable from the domain event id alone', async () => {
      const [outbox, consumed, decisions, notifications, messages] = await Promise.all([
        outboxFor(domainEventId),
        consumedFor(domainEventId),
        decisionsFor(day, sourceEventId),
        notificationsFor(day, sourceEventId),
        childMessagesFor(day, `${sourceEventId}:child`),
      ]);
      expect({
        outbox: outbox.length,
        consumedByNotificationConsumer: consumed.filter((c) =>
          String(c.consumer_name).toLowerCase().includes('notification'),
        ).length,
        decisions: decisions.length,
        notifications: notifications.length,
        childMessages: messages.length,
      }).toEqual({
        outbox: 1,
        consumedByNotificationConsumer: 1,
        decisions: 2,
        notifications: 1,
        childMessages: 1,
      });
    });

    // =======================================================================
    // ACT II — IDEMPOTENCY
    // =======================================================================

    describe('ACT II — the same event again: ZERO additional records, not «about one»', () => {
      it('the first run produced exactly 1 outbox row, 1 decision per audience, 1 notification, 1 child message', async () => {
        expect(await countCause(day, domainEventId, sourceEventId)).toEqual({
          outbox: 1,
          decisions: 2,
          notifications: 1,
          childMessages: 1,
        });
        // And nothing else in the family is a notification record either, so
        // «one» below is one in total and not one among several.
        expect(await countFamily(day)).toEqual({
          outbox: 1,
          decisions: 2,
          notifications: 1,
          childMessages: 1,
        });
      });

      it('THE REDELIVERY — the same outbox message published a second time writes NOTHING new', async () => {
        const beforeCause = await countCause(day, domainEventId, sourceEventId);
        const beforeFamily = await countFamily(day);

        // THE REAL FAILURE MODE. A relay that publishes and dies before marking
        // the row leaves exactly this: a PUBLISHED-then-PENDING row for an event
        // the consumer already handled. Reset in place rather than inserted, so
        // this is the SAME event and not a copy of it.
        await world.sys('put the same outbox message back on the queue', () =>
          world.prisma.$executeRawUnsafe(
            `UPDATE "outbox_messages"
               SET "status" = 'PENDING', "published_at" = NULL, "locked_by" = NULL,
                   "locked_at" = NULL, "next_attempt_at" = now() - interval '1 minute'
             WHERE "domain_event_id" = $1::uuid`,
            domainEventId,
          ),
        );

        const drain = await world.drainOutbox();
        expect(drain.failed).toBe(0);
        expect(drain.published).toBeGreaterThan(0); // it really was re-published

        expect(await countCause(day, domainEventId, sourceEventId)).toEqual(beforeCause);
        // ZERO ADDITIONAL, INCLUDING UNDER ANY OTHER KEY.
        expect(await countFamily(day)).toEqual(beforeFamily);
      });

      it('and the second consumption is still ONE `consumed_messages` row — the idempotency ledger did not double either', async () => {
        const consumed = await consumedFor(domainEventId);
        const notificationConsumer = consumed.filter((c) =>
          String(c.consumer_name).toLowerCase().includes('notification'),
        );
        expect(notificationConsumer).toHaveLength(1);
      });

      it('A THIRD delivery is also zero — this is a property, not a coincidence of the second attempt', async () => {
        const before = await countFamily(day);
        await world.sys('and once more', () =>
          world.prisma.$executeRawUnsafe(
            `UPDATE "outbox_messages"
               SET "status" = 'PENDING', "published_at" = NULL, "locked_by" = NULL,
                   "locked_at" = NULL, "next_attempt_at" = now() - interval '1 minute'
             WHERE "domain_event_id" = $1::uuid`,
            domainEventId,
          ),
        );
        await world.drainOutbox();
        expect(await countFamily(day)).toEqual(before);
      });

      it('the notification the parent reads over HTTP is still ONE, so the invariant is the product’s and not only the table’s', async () => {
        const inbox = await request(world.http).get(`${P}/notifications`).set(asParent(day));
        expect(inbox.status).toBe(200);
        const forThisCause = (inbox.body.items ?? inbox.body).filter(
          (n: any) => n.type === 'REWARD_GRANTED',
        );
        expect(forThisCause).toHaveLength(1);
      });
    });
  });

  // =========================================================================
  // ACT III — G9: QUIET HOURS, DEFERRED THEN RELEASED, EXACTLY ONCE
  // =========================================================================

  describe('ACT III — G9: earned at 23:30 Cairo, announced at 07:00 Cairo, once', () => {
    /** 23:30 Cairo on the golden day — the instant, not a guessed offset. */
    const LATE_NIGHT = utcWhenLocalIs('23:30', CAIRO);
    /** 07:15 Cairo the next morning: AFTER the 07:00 release instant, not on it. */
    const NEXT_MORNING = utcWhenLocalIs('07:15', CAIRO, 1);

    it('the local clock really is inside the default 21:00–07:00 window — the premise, measured', () => {
      expect(getBusinessTimeHHMM(LATE_NIGHT, CAIRO)).toBe('23:30');
      expect(getBusinessTimeHHMM(NEXT_MORNING, CAIRO)).toBe('07:15');
    });

    it('a reward earned at 23:30 announces NOTHING to the parent — and is not lost either', async () => {
      jest.setSystemTime(LATE_NIGHT);
      await earnAReward(night, 'واجب');
      const drain = await world.drainOutbox();
      expect(drain.failed).toBe(0);

      // NOT DELIVERED.
      const notifications = await rows(
        `SELECT * FROM "notifications" WHERE "family_id" = $1::uuid`,
        night.familyId,
      );
      expect(notifications).toHaveLength(0);

      // AND NOT LOST — `PC-D-005` was the defect where `DEFER` wrote no row and
      // the notification simply ceased to exist. There is a durable row with an
      // attempt counter, and it IS this system's only record of a delivery
      // attempt.
      const deliveries = await deliveriesFor(night);
      const parentRow = deliveries.filter((d) => d.target_audience === 'PARENT');
      expect(parentRow).toHaveLength(1);
      expect(parentRow[0].state).toBe('PENDING');
      expect(parentRow[0].defer_reason).toBe('QUIET_HOURS');
      expect(parentRow[0].attempt_count).toBe(0);
      // Scheduled for 07:00 LOCAL, which is the family's number and not UTC's.
      expect(getBusinessTimeHHMM(new Date(parentRow[0].scheduled_for), CAIRO)).toBe('07:00');
    });

    it('the DECISION row says DEFER, so «why did I not get it at 23:30?» has an answer in a column', async () => {
      const decisions = await rows(
        `SELECT * FROM "notification_decisions"
           WHERE "family_id" = $1::uuid AND "target_audience" = 'PARENT'`,
        night.familyId,
      );
      expect(decisions).toHaveLength(1);
      expect(decisions[0].decision).toBe('DEFER');
      expect(decisions[0].outcome).toBe('DEFER');
    });

    it('THE RELEASE — the 07:15 sweep turns the deferred row into exactly ONE notification', async () => {
      jest.setSystemTime(NEXT_MORNING);
      const report = await release.sweep(NEXT_MORNING);
      expect(report).toBeDefined();

      const notifications = await rows(
        `SELECT * FROM "notifications" WHERE "family_id" = $1::uuid`,
        night.familyId,
      );
      expect(notifications).toHaveLength(1);
      expect(notifications[0].user_id).toBe(night.ownerUserId);

      const deliveries = (await deliveriesFor(night)).filter((d) => d.target_audience === 'PARENT');
      expect(deliveries).toHaveLength(1);
      // The attempt was RECORDED, which is the leg of the chain that only this
      // table can carry.
      expect(deliveries[0].attempt_count).toBeGreaterThanOrEqual(1);
      expect(deliveries[0].state).not.toBe('PENDING');
    });

    it('EXACTLY ONCE — a SECOND sweep ten minutes later releases nothing, and a third does not either', async () => {
      const countNotifications = async (): Promise<number> =>
        Number(
          (
            await rows(
              `SELECT COUNT(*)::int AS n FROM "notifications" WHERE "family_id" = $1::uuid`,
              night.familyId,
            )
          )[0].n,
        );
      const afterFirstRelease = await countNotifications();
      expect(afterFirstRelease).toBe(1);

      await release.sweep(new Date(NEXT_MORNING.getTime() + 10 * 60 * 1000));
      expect(await countNotifications()).toBe(afterFirstRelease);

      await release.sweep(new Date(NEXT_MORNING.getTime() + 60 * 60 * 1000));
      expect(await countNotifications()).toBe(afterFirstRelease);
    });

    it('and the released notification carries the ORIGINAL cause’s key — the deferral did not break the chain', async () => {
      const events = await domainEvents(night, 'REWARD_GRANTED');
      expect(events).toHaveLength(1);
      const expectedKey = forDomainEvent(events[0].id);
      const notifications = await notificationsFor(night, expectedKey);
      expect(notifications).toHaveLength(1);
      // Which is also what makes the deferral idempotent: the key composed at
      // 23:30 is the key inserted at 07:00, so a redelivery of the same cause
      // still collides.
      const decisions = await decisionsFor(night, expectedKey);
      expect(decisions.length).toBeGreaterThanOrEqual(1);
    });
  });
});
