/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * ============================================================================
 * GOLDEN E2E-11 — G15 AND G16. THE TWO ADVERSARIES THIS PRODUCT ACTUALLY HAS.
 * ============================================================================
 *
 * G15 — THE CHILD. Not a hypothetical attacker: the child is the ONE actor in
 * this system who is both authenticated and directly incentivised to lie. Every
 * competitor in this category loses to the child circumvention rate (CONTEXT §1),
 * and a device-bound token that can declare its own outcome turns the entire
 * reward loop into a formality. So a child attempting to forge each of the four
 * things a reward depends on —
 *
 *   VERIFICATION  the outcome («I am VERIFIED»)
 *   SCORE         the number the outcome is computed from
 *   DATE          which business day the work counts for
 *   APPROVAL      the parent's own decision on a child-facing message
 *
 * — must be refused SERVER-SIDE, and refused in a way that leaves no row behind.
 * `PA-B-017` is the recorded reason this file exists: `quizCorrect` / `quizTotal`
 * were once fields on the child's own submit DTO with `canAutoApprove: true`
 * behind them, so a well-formed `{"quizCorrect":10,"quizTotal":10}` from the
 * child's own device was an auto-approved perfect score. They were DELETED rather
 * than ignored, precisely so that a client still sending them gets a 400 naming
 * the property instead of quietly falling back.
 *
 * G16 — THE MODEL. The other adversary is the one this product invited in. An LLM
 * asked to warm up a sentence for a child can return «أنت كسول ولم تنجز شيئًا
 * اليوم», and `F6-005` MEASURED that sentence being written into `child_messages`
 * verbatim: it was refused at the engine's own gate and then re-introduced by a
 * second rephrase that validated against the PARENT filter — six English
 * no-spyware regexes that have never heard of shaming.
 *
 * Both halves of that path are exercised here against the REAL database:
 *   ACT III  the ENGINE path — fail-CLOSED: the human-written template ships and
 *            the model's sentence reaches no table.
 *   ACT IV   the `FamilyCommunicationService` path over REAL HTTP — `PG-001`:
 *            the CHILD policy refuses and NOTHING is persisted. This is the
 *            residual hole the Phase F report left open, closed and measured.
 *
 * ---------------------------------------------------------------------------
 * THE ONE SUBSTITUTION IN THIS FILE, DECLARED HERE AND NOT HIDDEN IN THE
 * HARNESS. `AI_PROVIDER` is replaced by a provider that returns a chosen
 * sentence. It is the only way to ask «what happens when the model says THIS»,
 * and it is an EXTERNAL SERVICE — the same category of substitution, made at the
 * same `configure` seam, as E2E-07's Apple HTTP responses. Everything else is
 * real: real PostgreSQL, real Redis, real booted app, real HTTP, the real
 * `ChildSafetyFilterService`, the real `SafetyEngineService`, the real composer.
 * ---------------------------------------------------------------------------
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
  GOLDEN_NOON,
  type GoldenHousehold,
  type GoldenWorld,
} from './golden-world';
import { AI_PROVIDER } from '../../src/modules/ai-core/domain/ai-provider.port';
import { renderNotificationCopy } from '../../src/modules/notifications/domain/engine/notification-copy';

import request = require('supertest');

/**
 * THE SENTENCE. The exact string `F6-005` watched a model return and watched land
 * in a child's inbox verbatim. Kept as the fixture rather than paraphrased,
 * because the paraphrase is not the thing that happened.
 */
const MODEL_SAYS_SHAMING = 'أنت كسول ولم تنجز شيئًا اليوم';

/** The substituted provider — one field, set per act, declared above. */
const scriptedAi = {
  reply: '' as string,
  calls: 0,
  async complete(): Promise<string> {
    scriptedAi.calls += 1;
    if (!scriptedAi.reply) throw new Error('no scripted reply for this act');
    return scriptedAi.reply;
  },
};

describeGolden('GOLDEN E2E-11 — G15 the child who forges, G16 the model that shames', () => {
  let world: GoldenWorld;
  let home: GoldenHousehold;

  /** Restored in `afterAll` — a suite that leaves a global env flag on changes
   * every suite that runs after it in a `--runInBand` pass. */
  let rephraseFlagBefore: string | undefined;

  beforeAll(async () => {
    /**
     * THE ENVIRONMENT SWITCH, AND WHY IT IS TURNED ON HERE RATHER THAN WORKED
     * AROUND.
     *
     * `NotificationComposerService.rephraseEnabled()` reads
     * `NOTIFICATION_AI_REPHRASE_ENABLED` and is OFF by default — correctly, since
     * CONTEXT §3 principle 5 argues against a model call per notification. The
     * first run of ACT III below therefore never called the model at all, and
     * «the template shipped» was true FOR THE WRONG REASON: nothing had been
     * rephrased, so nothing had been rejected. That is a vacuous safety test, and
     * the assertion two tests below (`scriptedAi.calls > 0`) is what caught it.
     *
     * This is a DEPLOYMENT FLAG, not a stub: turning it on puts the suite in the
     * configuration a deployment with AI credentials runs in, which is the only
     * configuration in which G16's question has any meaning.
     */
    rephraseFlagBefore = process.env.NOTIFICATION_AI_REPHRASE_ENABLED;
    process.env.NOTIFICATION_AI_REPHRASE_ENABLED = 'true';

    freezeGoldenClock(GOLDEN_NOON);
    world = await bootGoldenWorld('golden E2E-11 (forgery + AI safety)', (builder) =>
      // THE ONE SUBSTITUTION — see the header. Made at the seam the harness
      // exposes for exactly this, so it is visible in the scenario file.
      builder.overrideProvider(AI_PROVIDER).useValue(scriptedAi),
    );
    const year = Number(GOLDEN_NOON.toISOString().slice(0, 4));
    home = await world.register('e2e11', {
      childName: 'محمد',
      childDateOfBirth: `${year - 12}-01-05`,
    });
    await ageTheHousehold(world, home, goldenAt('08:00'));
  }, 240_000);

  afterAll(async () => {
    if (rephraseFlagBefore === undefined) {
      delete process.env.NOTIFICATION_AI_REPHRASE_ENABLED;
    } else {
      process.env.NOTIFICATION_AI_REPHRASE_ENABLED = rephraseFlagBefore;
    }
    jest.useRealTimers();
    if (world) await world.close();
  });

  // ---------------------------------------------------------------- helpers

  const childMessages = (category?: string): Promise<any[]> =>
    category
      ? world.raw<any[]>(
          `SELECT * FROM "child_messages" WHERE "family_id" = $1::uuid AND "category" = $2`,
          home.familyId,
          category,
        )
      : world.raw<any[]>(`SELECT * FROM "child_messages" WHERE "family_id" = $1::uuid`, home.familyId);

  const ledgerEarnRows = (): Promise<any[]> =>
    world.raw<any[]>(
      `SELECT * FROM "rewards_ledger_entries" WHERE "family_id" = $1::uuid AND "type" = 'EARN'`,
      home.familyId,
    );

  async function createProgram(unit: string, verificationLevel = 'SELF_CHECK'): Promise<string> {
    const program = await request(world.http)
      .post(`${P}/reward-programs`)
      .set(asParent(home))
      .send({
        childId: home.childId,
        category: 'HOUSEWORK',
        activity: 'CHORE',
        targetSpec: { quantity: 1, unit },
        durationMinutes: 10,
        verificationLevel,
        rewardSpec: { type: 'POINTS', amount: 10 },
      });
    expect([200, 201]).toContain(program.status);
    return program.body.id;
  }

  async function startAchievement(programId: string): Promise<string> {
    const started = await request(world.http)
      .post(`${P}/self/achievements/start`)
      .set(asChild(home))
      .send({ programId });
    expect([200, 201]).toContain(started.status);
    return started.body.id;
  }

  // =========================================================================
  // G15 — THE CHILD WHO FORGES
  // =========================================================================

  describe('G15 — a child forging verification, score, date or approval is refused server-side', () => {
    let achievementId: string;

    beforeAll(async () => {
      achievementId = await startAchievement(await createProgram('forgery'));
    }, 120_000);

    /**
     * `forbidNonWhitelisted: true` in `global-pipeline.ts` — the SAME function
     * `main.ts` calls, so this is the deployed contract and not a test one. An
     * unknown property is a 400 that NAMES the property, which is the difference
     * between «rejected» and «silently stripped and then trusted».
     */
    const FORGERIES: ReadonlyArray<{ readonly what: string; readonly body: Record<string, unknown> }> =
      Object.freeze([
        // --- VERIFICATION: declaring the outcome ---
        { what: 'VERIFICATION — status', body: { selfConfirmed: true, status: 'VERIFIED' } },
        { what: 'VERIFICATION — result', body: { selfConfirmed: true, result: 'VERIFIED' } },
        { what: 'VERIFICATION — verified', body: { selfConfirmed: true, verified: true } },
        {
          what: 'VERIFICATION — verificationLevel (downgrading its own bar)',
          body: { selfConfirmed: true, verificationLevel: 'SELF_CHECK' },
        },
        { what: 'VERIFICATION — autoApprove', body: { selfConfirmed: true, autoApprove: true } },
        // --- SCORE: declaring the number the outcome is computed from ---
        // `PA-B-017` — these two WERE real fields with `canAutoApprove: true`.
        { what: 'SCORE — quizCorrect / quizTotal (`PA-B-017` itself)', body: { quizCorrect: 10, quizTotal: 10 } },
        { what: 'SCORE — score', body: { selfConfirmed: true, score: 100 } },
        { what: 'SCORE — pointsAwarded', body: { selfConfirmed: true, pointsAwarded: 9999 } },
        { what: 'SCORE — rewardSpec', body: { selfConfirmed: true, rewardSpec: { type: 'POINTS', amount: 9999 } } },
        // --- DATE: declaring which business day the work counts for ---
        { what: 'DATE — completedAt', body: { selfConfirmed: true, completedAt: '2020-01-01T00:00:00.000Z' } },
        { what: 'DATE — businessDate', body: { selfConfirmed: true, businessDate: '2020-01-01' } },
        { what: 'DATE — createdAt', body: { selfConfirmed: true, createdAt: '2020-01-01T00:00:00.000Z' } },
        { what: 'DATE — verifiedAt', body: { selfConfirmed: true, verifiedAt: '2020-01-01T00:00:00.000Z' } },
        // --- IDENTITY: naming a subject at all ---
        // The values are literals rather than this household's real ids on
        // purpose, and it is not laziness: the point is that the FIELD does not
        // exist on the child's surface. The child it acts for is resolved from
        // the DEVICE's own pairing, server-side, and there is nowhere to put an
        // alternative — so a well-formed id is refused exactly as a foreign one
        // is, and this table is evaluated before any fixture exists.
        { what: 'IDENTITY — childId', body: { selfConfirmed: true, childId: '00000000-0000-4000-8000-000000000001' } },
        { what: 'IDENTITY — familyId', body: { selfConfirmed: true, familyId: '00000000-0000-4000-8000-000000000002' } },
      ]);

    it.each(FORGERIES)('$what is rejected with 400, and the property is NAMED', async ({ body }) => {
      const response = await request(world.http)
        .post(`${P}/self/achievements/${achievementId}/submit`)
        .set(asChild(home))
        .send(body);
      expect(response.status).toBe(400);
      // Named, not merely refused: a 400 whose message does not say which
      // property is a 400 a client will guess at and a reviewer will not learn
      // from. The offending key appears in the response.
      const serialised = JSON.stringify(response.body);
      const forgedKey = Object.keys(body).find((k) => k !== 'selfConfirmed');
      expect(serialised).toContain(forgedKey);
    });

    it('the achievement is STILL not verified after fifteen forgery attempts, and the ledger is empty', async () => {
      const mine = await request(world.http).get(`${P}/self/achievements/mine`).set(asChild(home));
      expect(mine.status).toBe(200);
      const target = (mine.body.items ?? mine.body).find((a: any) => a.id === achievementId);
      expect(target).toBeDefined();
      expect(target.status).not.toBe('VERIFIED');
      expect(await ledgerEarnRows()).toHaveLength(0);
    });

    it('APPROVAL — the child cannot approve a message addressed to itself; the parent’s gate is the parent’s', async () => {
      // First: produce a real PENDING child message through the real loop.
      scriptedAi.reply = '';
      const programId = await createProgram('gate');
      const id = await startAchievement(programId);
      const submitted = await request(world.http)
        .post(`${P}/self/achievements/${id}/submit`)
        .set(asChild(home))
        .send({ selfConfirmed: true });
      expect(submitted.body.status).toBe('VERIFIED');
      await world.drainOutbox();

      const pending = await childMessages('REWARD_GRANTED_CHILD');
      expect(pending).toHaveLength(1);
      const messageId = pending[0].id;
      expect(pending[0].approval_status).toBe('PENDING');

      // THE FORGERY: the child's own device token on the PARENT approval route.
      const approve = await request(world.http)
        .post(`${P}/life-intelligence/communication/${home.childId}/${messageId}/approve`)
        .set(asChild(home))
        .send({});
      expect([401, 403]).toContain(approve.status);

      // AND THE ROW DID NOT MOVE — the refusal is not merely an HTTP status.
      const after = await childMessages('REWARD_GRANTED_CHILD');
      expect(after[0].approval_status).toBe('PENDING');
      expect(after[0].delivered_at).toBeNull();

      // NOR CAN THE CHILD READ IT YET, which is what the gate is FOR.
      const inbox = await request(world.http).get(`${P}/life-intelligence/self/messages`).set(asChild(home));
      expect(inbox.status).toBe(200);
      expect(inbox.body).toHaveLength(0);
    });

    it('APPROVAL — nor can the child author a message to itself, or run any parent surface', async () => {
      const asTheChild = asChild(home);
      const attempts = [
        request(world.http)
          .post(`${P}/life-intelligence/communication/${home.childId}/parent-message`)
          .set(asTheChild)
          .send({ category: 'encouragement', title: 'من نفسي', body: 'أنا أوافق على كل شيء' }),
        request(world.http)
          .post(`${P}/life-intelligence/communication/${home.childId}/ai-draft`)
          .set(asTheChild)
          .send({ category: 'SET_SCREEN_TIME_POLICY', title: 'عنوان', body: 'نص' }),
        request(world.http)
          .post(`${P}/reward-programs`)
          .set(asTheChild)
          .send({
            childId: home.childId,
            category: 'HOUSEWORK',
            activity: 'CHORE',
            targetSpec: { quantity: 1, unit: 'مهمة' },
            durationMinutes: 1,
            verificationLevel: 'SELF_CHECK',
            rewardSpec: { type: 'POINTS', amount: 9999 },
          }),
        request(world.http).get(`${P}/life-intelligence/communication/pending`).set(asTheChild),
      ];
      for (const response of await Promise.all(attempts)) {
        expect([401, 403]).toContain(response.status);
      }
      // And none of it authored anything: the only child messages in this family
      // are the ones the ENGINE produced.
      const authored = await world.raw<any[]>(
        `SELECT * FROM "child_messages" WHERE "family_id" = $1::uuid AND "author_type" = 'PARENT'`,
        home.familyId,
      );
      expect(authored).toHaveLength(0);
    });
  });

  // =========================================================================
  // G16 — THE MODEL THAT SHAMES
  // =========================================================================

  describe('G16 — unsafe AI output is caught by the CHILD policy and never persisted', () => {
    it('ACT III — THE ENGINE PATH: the model shames, the human-written TEMPLATE ships instead', async () => {
      scriptedAi.reply = MODEL_SAYS_SHAMING;
      scriptedAi.calls = 0;

      const before = (await childMessages('REWARD_GRANTED_CHILD')).length;

      const programId = await createProgram('ai-engine');
      const id = await startAchievement(programId);
      const submitted = await request(world.http)
        .post(`${P}/self/achievements/${id}/submit`)
        .set(asChild(home))
        .send({ selfConfirmed: true });
      expect(submitted.body.status).toBe('VERIFIED');
      const drain = await world.drainOutbox();
      // FAIL-CLOSED IS NOT FAIL-SILENT: the notification still happened.
      expect(drain.failed).toBe(0);

      const rows = await childMessages('REWARD_GRANTED_CHILD');
      expect(rows).toHaveLength(before + 1);

      // THE MODEL'S SENTENCE IS IN NO ROW OF THIS TABLE. Asserted over the whole
      // table rather than the newest row, because `F6-005`'s defect wrote it from
      // a DIFFERENT code path than the one being watched.
      for (const row of await childMessages()) {
        expect(row.body).not.toContain('كسول');
        expect(row.body).not.toBe(MODEL_SAYS_SHAMING);
        expect(row.title).not.toContain('كسول');
      }

      // AND WHAT SHIPPED IS THE CATALOGUE'S OWN LINE, byte-identical, at the band
      // and locale the decision row names. «Something safe» is not the assertion;
      // «the approved template» is.
      const decisions = await world.raw<any[]>(
        `SELECT * FROM "notification_decisions"
           WHERE "family_id" = $1::uuid AND "event_type" = 'REWARD_GRANTED_CHILD'`,
        home.familyId,
      );
      // PAIRED BY CAUSE, not by row order: the clock is frozen, so every row
      // shares one `created_at` and any ordering degrades to a random UUID.
      let matchedOne = false;
      for (const d of decisions) {
        const paired = rows.filter((r) => r.source_event_id === `${d.source_event_id}:child`);
        if (paired.length === 0) continue;
        const rendered = renderNotificationCopy({
          key: d.copy_key,
          audience: 'CHILD',
          toneBand: d.age_band,
          locale: d.locale,
          variables: {},
        });
        expect(paired[0].body).toBe(rendered.body);
        expect(paired[0].title).toBe(rendered.title);
        matchedOne = true;
      }
      expect(matchedOne).toBe(true);
    });

    it('ACT III — and the model really WAS called, so this is a rejection and not a provider that never ran', () => {
      // Without this, «the template shipped» would also be true of a build where
      // the AI is simply unwired — which is the shape of a vacuous safety test.
      expect(scriptedAi.calls).toBeGreaterThan(0);
    });

    it('ACT IV — `PG-001` OVER REAL HTTP: the parent draft route refuses the model’s sentence and writes NOTHING', async () => {
      scriptedAi.reply = MODEL_SAYS_SHAMING;
      const before = (await childMessages()).length;

      // A PARENT, drafting an AI message to their own child, with a SAFE seed.
      // `SET_SCREEN_TIME_POLICY` is a real member of the recommendation
      // whitelist, so `PE-N-001`'s vocabulary check passes and the request gets
      // all the way to the rephrase — which is the only way to reach the defect.
      const response = await request(world.http)
        .post(`${P}/life-intelligence/communication/${home.childId}/ai-draft`)
        .set(asParent(home))
        .send({ category: 'SET_SCREEN_TIME_POLICY', title: 'وقت الشاشة', body: 'أحسنت اليوم، واصل' });

      expect(response.status).toBe(400);
      expect(JSON.stringify(response.body)).toContain('PG-001');

      // ZERO NEW ROWS. This is the assertion the Phase F report left open: before
      // `PG-001` this request returned 201 and the shaming sentence was the row.
      expect(await childMessages()).toHaveLength(before);
      for (const row of await childMessages()) {
        expect(row.body).not.toContain('كسول');
      }
    });

    it('ACT IV — the refusal does not leak the text it refused, and the same route still WORKS for safe output', async () => {
      // 1. NO LEAK. A rejected child-facing string is itself the thing that
      //    tripped the filter, and this body reaches a log and an HTTP client.
      scriptedAi.reply = MODEL_SAYS_SHAMING;
      const refused = await request(world.http)
        .post(`${P}/life-intelligence/communication/${home.childId}/ai-draft`)
        .set(asParent(home))
        .send({ category: 'SET_SCREEN_TIME_POLICY', title: 'وقت الشاشة', body: 'أحسنت اليوم، واصل' });
      expect(refused.status).toBe(400);
      expect(JSON.stringify(refused.body)).not.toContain('كسول');

      // 2. A GATE, NOT A WALL. The same route, the same parent, the same child —
      //    a safe in-band rephrase is accepted and stored PENDING. Without this,
      //    «nothing was written» would also describe a broken endpoint.
      scriptedAi.reply = 'أحسنت اليوم، واصل بنفس الروح';
      const before = (await childMessages()).length;
      const accepted = await request(world.http)
        .post(`${P}/life-intelligence/communication/${home.childId}/ai-draft`)
        .set(asParent(home))
        .send({ category: 'SET_SCREEN_TIME_POLICY', title: 'وقت الشاشة', body: 'أحسنت اليوم، واصل' });
      expect([200, 201]).toContain(accepted.status);
      expect(await childMessages()).toHaveLength(before + 1);
      expect(accepted.body.approvalStatus ?? accepted.body.approval_status).toBe('PENDING');
      expect(accepted.body.deliveredAt ?? accepted.body.delivered_at ?? null).toBeNull();
    });

    it('ACT IV — a model returning an off-platform CONTACT is refused too: the list is not one word long', async () => {
      const before = (await childMessages()).length;
      for (const unsafe of [
        'راسلنا على coach@example.com بسرعة', // PII_LEAK
        'اذهب إلى https://example.com الآن', // EXTERNAL_ACTION
        'أخوك أنجز أكثر منك بكثير', // COMPARISON
        'سيتم حظرك من الجهاز الآن', // THREAT
      ]) {
        scriptedAi.reply = unsafe;
        const response = await request(world.http)
          .post(`${P}/life-intelligence/communication/${home.childId}/ai-draft`)
          .set(asParent(home))
          .send({ category: 'SET_SCREEN_TIME_POLICY', title: 'وقت الشاشة', body: 'أحسنت اليوم، واصل' });
        expect(`${unsafe} -> ${response.status}`).toBe(`${unsafe} -> 400`);
      }
      expect(await childMessages()).toHaveLength(before);
    });
  });
});
