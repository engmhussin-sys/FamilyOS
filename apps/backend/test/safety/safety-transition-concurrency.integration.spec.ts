/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * ===========================================================================
 * TWO OPERATORS, ONE CRITICAL ALERT — proven against a real PostgreSQL.
 * ===========================================================================
 *
 * THE DEFECT THIS EXISTS FOR. `SafetyReviewService.transition` read the alert's
 * status, checked the move against the transition table, and then wrote:
 *
 *     UPDATE ai_alerts SET status = ... WHERE id = $1
 *
 * No `AND status = <the status we just read>`, no lock, no transaction. Two
 * members of the safety desk opening the same CRITICAL alert therefore BOTH
 * read `NEW`, BOTH found a legal move, and both wrote — last one wins. A
 * dismissal could silently overwrite an escalation, and both operators were
 * told they had succeeded.
 *
 * On a product for children that is not a race to fix later. It is the failure
 * the entire review workflow exists to prevent.
 *
 * ── WHY THIS TEST RUNS THE SERVICE AND NOT A COPY OF ITS SQL ───────────
 *
 * The sibling proof `test/database/rewards-concurrency.integration.spec.ts`
 * imports the production SQL constants. This service's statements are inline
 * template literals, so the only way to test the REAL statement is to call the
 * real method — which also puts the `$transaction`, the RLS `set_config` and
 * the audit write inside the proof rather than outside it.
 *
 * Runs only when INTEGRATION_DATABASE_URL points at a database built from
 * prisma/migrations. Skipped — loudly, never silently passed — otherwise.
 */
import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';

import { AuditService } from '../../src/modules/audit/application/audit.service';
import { SafetyReviewService } from '../../src/modules/safety/application/services/safety-review.service';
import type { OperatorSession } from '../../src/modules/operators/application/operator-session.service';
import { createTestPrisma, type TestPrismaHandle } from '../tenancy/prisma-test-client';

const CONNECTION_STRING = process.env.INTEGRATION_DATABASE_URL;
const describeIfDb = CONNECTION_STRING ? describe : describe.skip;

const operator = (email: string): OperatorSession => ({
  operatorId: randomUUID(),
  email,
  role: 'SAFETY',
  issuedAt: new Date().toISOString(),
});

describeIfDb('the safety desk under concurrency (real PostgreSQL)', () => {
  let handle: TestPrismaHandle;
  let pool: Pool;
  let service: SafetyReviewService;

  const familyId = randomUUID();
  const childId = randomUUID();

  beforeAll(async () => {
    pool = new Pool({ connectionString: CONNECTION_STRING });
    handle = createTestPrisma();
    service = new SafetyReviewService(handle.scoped as any, new AuditService(handle.scoped as any));

    await pool.query('INSERT INTO families (id, name, updated_at) VALUES ($1, $2, now())', [
      familyId,
      'Safety Concurrency Family',
    ]);
    await pool.query(
      'INSERT INTO children (id, family_id, first_name, date_of_birth, updated_at) VALUES ($1,$2,$3,$4,now())',
      [childId, familyId, 'Concurrency Child', '2015-01-01'],
    );
  });

  afterAll(async () => {
    await pool.query('DELETE FROM families WHERE id = $1', [familyId]);
    await handle.disconnect();
    await pool.end();
  });

  /** A fresh CRITICAL alert in `NEW`, which is the only state it could be in
   * before this workflow existed. */
  async function seedAlert(): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO ai_alerts
         (id, family_id, child_id, category, severity, status, title, description,
          source_module, source_event_id, created_at, updated_at)
       VALUES ($1,$2,$3,'HEALTH','CRITICAL','NEW',$4,$5,'test.concurrency',$6, now(), now())`,
      [id, familyId, childId, 'Concurrency alert', 'Words about a child in trouble.', randomUUID()],
    );
    return id;
  }

  it('THE POINT — two operators acting at once produce ONE winner, not a last-write-wins', async () => {
    const alertId = await seedAlert();

    const escalating = service.transition(alertId, 'ESCALATED', operator('a@abny.app'), 'Escalating: this looks real.');
    const dismissing = service.transition(alertId, 'DISMISSED', operator('b@abny.app'), 'Dismissing: false positive.');

    const outcomes = await Promise.allSettled([escalating, dismissing]);

    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o) => o.status === 'rejected');

    // Exactly one succeeded. Before the fix BOTH did.
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // And the loser was told the truth, by name, rather than being told it worked.
    const error = (rejected[0] as PromiseRejectedResult).reason;
    expect(error?.response?.code ?? error?.getResponse?.()?.code).toBe('ALERT_MOVED_CONCURRENTLY');

    // The row holds the winner's status and nothing else.
    const { rows } = await pool.query('SELECT status::text AS status FROM ai_alerts WHERE id = $1', [alertId]);
    const winner = (fulfilled[0] as PromiseFulfilledResult<{ to: string }>).value.to;
    expect(rows[0].status).toBe(winner);
  }, 30_000);

  it('the loser writes NOTHING — no note, no audit row, no half-finished trail', async () => {
    const alertId = await seedAlert();

    const outcomes = await Promise.allSettled([
      service.transition(alertId, 'ESCALATED', operator('a@abny.app'), 'Escalating: this looks real.'),
      service.transition(alertId, 'DISMISSED', operator('b@abny.app'), 'Dismissing: false positive.'),
    ]);
    expect(outcomes.filter((o) => o.status === 'rejected')).toHaveLength(1);

    // ONE note and ONE audit row. This is the half a compare-and-set alone would
    // not give: without the surrounding transaction the loser could still leave
    // a note explaining a move that never happened.
    const notes = await pool.query('SELECT count(*)::int AS n FROM ai_alert_notes WHERE alert_id = $1', [alertId]);
    expect(notes.rows[0].n).toBe(1);

    const audits = await pool.query(
      `SELECT count(*)::int AS n FROM audit_logs
        WHERE entity_id = $1 AND action = 'safety.alert_reviewed'`,
      [alertId],
    );
    expect(audits.rows[0].n).toBe(1);
  }, 30_000);

  it('ten simultaneous reviews of one alert settle it exactly once', async () => {
    const alertId = await seedAlert();

    const attempts = Array.from({ length: 10 }, (_, i) =>
      service.transition(alertId, 'REVIEWED', operator(`op${i}@abny.app`), `Reviewed by operator number ${i}.`),
    );
    const outcomes = await Promise.allSettled(attempts);

    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);

    // The other nine are refusals, not silent no-ops and not 500s. NEW -> REVIEWED
    // is legal, so every one of them passed the transition table and was stopped
    // by the compare-and-set alone.
    for (const outcome of outcomes.filter((o) => o.status === 'rejected')) {
      const reason = (outcome as PromiseRejectedResult).reason;
      expect(reason?.response?.code ?? reason?.getResponse?.()?.code).toBe('ALERT_MOVED_CONCURRENTLY');
    }

    const notes = await pool.query('SELECT count(*)::int AS n FROM ai_alert_notes WHERE alert_id = $1', [alertId]);
    expect(notes.rows[0].n).toBe(1);
  }, 30_000);

  it('a SETTLED alert still moves when only one operator acts — the fix is not a freeze', async () => {
    const alertId = await seedAlert();

    const first = await service.transition(alertId, 'REVIEWED', operator('a@abny.app'), 'Looked at it and acted.');
    expect(first.to).toBe('REVIEWED');

    // Reopening, then escalating. Sequential moves are unaffected by the
    // compare-and-set: it only ever refuses a move whose starting state is gone.
    const reopened = await service.transition(alertId, 'NEW', operator('b@abny.app'), 'Reopening: new information.');
    expect(reopened.from).toBe('REVIEWED');

    const escalated = await service.transition(alertId, 'ESCALATED', operator('b@abny.app'), 'Escalating after all.');
    expect(escalated.to).toBe('ESCALATED');

    const { rows } = await pool.query(
      'SELECT status::text AS status, reviewed_by_operator_id FROM ai_alerts WHERE id = $1',
      [alertId],
    );
    expect(rows[0].status).toBe('ESCALATED');
    expect(rows[0].reviewed_by_operator_id).not.toBeNull();
  }, 30_000);
});
