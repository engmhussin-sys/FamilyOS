/**
 * THE OPERATOR BREAKDOWN'S STATEMENTS, READ AS TEXT.
 *
 * This suite needs no database on purpose. What it proves is a property of the
 * SQL SOURCE — «this query can never return an identifier», «these two panels
 * count the same reasons» — and a property of the source is cheaper and more
 * total to assert against the source than against one execution of it. The
 * companion suite `decision-analytics-breakdown.e2e.spec.ts` proves the
 * behaviour against real rows; this one proves the shape.
 *
 * It is the same discipline `notification-decision.sql.ts` was written for: the
 * statements are exported constants precisely so a `WHERE` clause cannot be
 * dropped from production without a test going red.
 */
import {
  SQL_DECISION_ANALYTICS,
  SQL_DECISION_BREAKDOWN_DIMENSIONS,
  SQL_DECISION_BREAKDOWN_TOP_TYPES,
  SQL_DECISION_TOP_CAUSES,
  SQL_DELIVERY_ERROR_REASONS,
} from '../../src/modules/notifications/infrastructure/notification-decision.sql';
import { NOTIFICATION_TRIGGERS } from '../../src/modules/notifications/domain/engine/notification-decision.types';

/** The three statements the platform breakdown runs, and nothing else. */
const BREAKDOWN_STATEMENTS: ReadonlyArray<readonly [string, string]> = [
  ['SQL_DECISION_BREAKDOWN_DIMENSIONS', SQL_DECISION_BREAKDOWN_DIMENSIONS],
  ['SQL_DECISION_BREAKDOWN_TOP_TYPES', SQL_DECISION_BREAKDOWN_TOP_TYPES],
  ['SQL_DECISION_TOP_CAUSES', SQL_DECISION_TOP_CAUSES],
];

describe('the operator decision breakdown — the statements themselves', () => {
  /**
   * THE PRIVACY PROPERTY, AT THE SOURCE.
   *
   * `decision-analytics-breakdown.e2e.spec.ts` asserts that the RESPONSE has no
   * identifying key. That assertion can only ever cover the columns a query
   * happened to select on the day it ran. This one covers the query: a column
   * that is never named cannot be returned by any input.
   */
  it.each(BREAKDOWN_STATEMENTS)('%s names no identifying column at all', (_name, sql) => {
    for (const column of ['family_id', 'child_id', 'source_event_id', 'explanation']) {
      expect(sql).not.toContain(column);
    }
    // `notifications` / `child_messages` are where the rendered sentence lives.
    // The breakdown must not join to either — the roll-up's LEFT JOIN to
    // `notifications` exists to count `read_at` and this query counts nothing
    // that needs it.
    expect(sql).not.toContain('JOIN');
    expect(sql).not.toContain('child_messages');
  });

  it.each(BREAKDOWN_STATEMENTS)('%s is bounded by the business-date range', (_name, sql) => {
    // Both ends. A statement with only `>=` is an unbounded forward scan, which
    // is exactly the shape the route's 92-day cap exists to prevent, and a cap
    // enforced in TypeScript over a query that ignores one end is not a cap.
    expect(sql).toContain('d."business_date" >= $1::date');
    expect(sql).toContain('d."business_date" <= $2::date');
  });

  it.each(BREAKDOWN_STATEMENTS)('%s applies the same four optional filters', (_name, sql) => {
    // Identical text to `SQL_DECISION_ANALYTICS`'s own filter, so the roll-up
    // and every slice of the breakdown are always over ONE population. Two
    // panels on one screen filtered two different ways is a bug that presents
    // as "the numbers don't add up" months later.
    expect(sql).toContain('($3::text IS NULL OR d."country_code" = $3::text)');
    expect(sql).toContain('($4::text IS NULL OR d."age_band" = $4::text)');
    expect(sql).toContain('($5::text IS NULL OR d."target_audience" = $5::text)');
    expect(sql).toContain('($6::text IS NULL OR d."category" = $6::text)');
  });

  it('the two OPEN vocabularies are the two statements that carry a LIMIT', () => {
    // Notification type and cause (`event_type`) are written by producers, so
    // their cardinality grows with the codebase.
    expect(SQL_DECISION_BREAKDOWN_TOP_TYPES).toContain('LIMIT $7::int');
    expect(SQL_DECISION_TOP_CAUSES).toContain('LIMIT $7::int');
    // The grouping-set statement needs none and deliberately has none: audience
    // is CHECK-constrained to two values, source to the eight members of
    // NOTIFICATION_TRIGGERS, provenance to the registered decision providers,
    // and date to the route's own 92-day cap. If that ceases to be true this
    // assertion is where the argument gets revisited.
    expect(SQL_DECISION_BREAKDOWN_DIMENSIONS).not.toContain('LIMIT');
    expect(NOTIFICATION_TRIGGERS.length).toBe(8);
  });

  it('both top-N statements order deterministically, so a tie does not reshuffle the page', () => {
    // Count DESC alone leaves ties to the planner, and an operator watching a
    // list swap rows between two loads concludes the DATA moved.
    expect(SQL_DECISION_BREAKDOWN_TOP_TYPES).toContain(
      'ORDER BY COUNT(*) DESC, d."notification_type" ASC',
    );
    expect(SQL_DECISION_TOP_CAUSES).toContain('ORDER BY COUNT(*) DESC, d."event_type" ASC');
  });

  it('the grouping-set statement slices exactly the five declared sets — no more, no fewer', () => {
    // Written out rather than counted, because "which dimensions does this
    // endpoint expose" is a privacy decision, not an implementation detail. A
    // sixth grouping set added here is a deliberate diff on this line.
    expect(SQL_DECISION_BREAKDOWN_DIMENSIONS).toContain(
      [
        'GROUP BY GROUPING SETS (',
        '   (d."target_audience"),',
        '   (d."trigger"),',
        '   (d."provider_id"),',
        '   (d."business_date"),',
        '   ()',
        ' )',
      ].join('\n'),
    );
  });

  it('the roll-up and the breakdown count the SAME delivery-error reasons', () => {
    // The reason set is written once and interpolated. This is the ratchet that
    // stops the older statement being left behind when it is widened: an
    // operator reading "delivery errors" twice on one screen must not see two
    // numbers.
    expect(SQL_DELIVERY_ERROR_REASONS).toBe(`('DELIVERY_ERROR', 'DEFER_ENQUEUE_FAILED')`);
    expect(SQL_DECISION_ANALYTICS).toContain(`d."outcome_reason" IN ${SQL_DELIVERY_ERROR_REASONS}`);
    for (const [, sql] of BREAKDOWN_STATEMENTS) {
      expect(sql).toContain(`d."outcome_reason" IN ${SQL_DELIVERY_ERROR_REASONS}`);
    }
  });

  it('every breakdown row carries BOTH the engine verdict and the pipeline outcome', () => {
    // The two disagreeing — engine decided SEND, pipeline delivered nothing —
    // is the most useful row in this table, and it is only visible while both
    // are on the same row of the same query.
    for (const [, sql] of BREAKDOWN_STATEMENTS) {
      expect(sql).toContain(`d."decision" = 'SEND'`);
      expect(sql).toContain(`d."decision" = 'DEFER'`);
      expect(sql).toContain(`d."decision" = 'SUPPRESS'`);
      expect(sql).toContain(`d."outcome" = 'SEND'`);
      expect(sql).toContain('AS delivery_errors');
    }
  });
});
