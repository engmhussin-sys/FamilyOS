/**
 * PHASE C P4 — THE RETENTION SCHEDULE, AS EXECUTABLE DATA.
 *
 * WHAT WAS WRONG BEFORE. `DataRetentionPolicyService` describes nine
 * CATEGORIES in prose; `DataRetentionEnforcementService` executed five of them
 * against five tables; A2 §9.1 measured the coverage at 5 tables of 60 (8%);
 * and NOTHING CALLED ANY OF IT — the enforcement service's own docstring says
 * «Not scheduled anywhere itself.» A retention policy that is a document, an
 * unreachable method and a coverage figure of 8% is not a retention policy. For
 * a product holding children's behavioural data in a pilot, that is a
 * compliance condition, which is exactly how Phase B classified it (blocker #5).
 *
 * WHAT THIS FILE IS. One row per TABLE — not per category — because a table is
 * what a DELETE names and a category is what a lawyer reads. Each row carries
 * the period, the mechanism, and, crucially, `decision`: whether the number
 * beside it is a documented policy, an engineering default this project chose
 * and is prepared to defend, or a genuine open business/legal question that has
 * been given a safe default so the MECHANISM can ship while the NUMBER is
 * settled. Flagging that difference is the honest form of "implement the
 * mechanism, use a documented default, and flag the decision".
 *
 * WHAT IS DELIBERATELY ABSENT, with reasons, because an absence with no reason
 * is indistinguishable from an oversight:
 *
 *   device_pairing_events   Append-only security audit trail (Decision-059).
 *                           Never auto-deleted while the account is live; this
 *                           is the trail the pairing/trust states rely on.
 *   invoices                Seven-year tax retention (Egypt/KSA). Deleting one
 *                           is a legal problem, not a privacy improvement.
 *   parental_consents       Seven years AFTER account deletion, per the target
 *                           schedule — proving consent existed outlives the
 *                           data the consent covered.
 *   rewards_ledger_entries  The child's own economy. Deleting it silently
 *                           changes balances a family can see. Unbounded by
 *                           design, and the target schedule agrees.
 *   the health / faith /    Longitudinal records that ARE the product's value
 *   learning logs           to the family. A retention period here is a
 *                           PRODUCT decision about what a family is promised,
 *                           not an engineering one, and it is raised in the
 *                           report's open-decisions section rather than
 *                           guessed at in code.
 */

export type RetentionMechanism = 'HARD_DELETE' | 'ANONYMIZE';

/**
 * Where the retention PERIOD came from. This is the field that keeps the
 * report honest.
 */
export type RetentionDecisionSource =
  /** Written in this project's own target retention schedule (docs §5.4). */
  | 'DOCUMENTED_POLICY'
  /** Chosen here, defensible, and stated as an engineering default. */
  | 'ENGINEERING_DEFAULT'
  /** A real legal/product question. The mechanism ships; the number is provisional. */
  | 'OPEN_BUSINESS_DECISION';

export interface RetentionTarget {
  /** Stable key used in `job_runs.details` and in the log line. */
  readonly key: string;
  readonly table: string;
  /** The single column age is measured on. */
  readonly timeColumn: string;
  readonly retentionDays: number;
  readonly mechanism: RetentionMechanism;
  /** Whether the table has a `family_id` column that can scope the sweep. */
  readonly tenantScoped: boolean;
  readonly decision: RetentionDecisionSource;
  /**
   * An extra SQL predicate, already parameter-free and written against the
   * table itself. NEVER built from input — every string in this file is a
   * compile-time constant, which is what makes the `$executeRawUnsafe` calls
   * that consume them safe.
   */
  readonly extraPredicate?: string;
  readonly rationale: string;
}

/** 24 months for ordinary audit rows. */
const AUDIT_RETENTION_DAYS = 730;

/**
 * The action prefixes that make an audit row a SECURITY record, which the
 * target schedule retains for seven years rather than twenty-four months.
 *
 * A PREFIX LIST AND NOT A COLUMN, and the trade is stated rather than hidden:
 * A2 DA-008 asks for an `is_security_event` boolean on `audit_logs`, and that
 * is the right long-term answer. It is not taken here because the flag would
 * have to be backfilled by inferring it from `action` — i.e. by this exact
 * list — and a backfilled boolean whose derivation lives in a migration is
 * harder to review later than a derivation that lives in one named constant.
 * The column is recorded as the follow-up, and this list is what the sweep
 * uses meanwhile. Erring is one-directional by construction: an unrecognised
 * action prefix is treated as ORDINARY and therefore deleted at 24 months, so
 * a new security action added without updating this list under-retains rather
 * than over-retains. That is the wrong direction for compliance, which is why
 * `test/data-retention/retention-targets.spec.ts` asserts every action prefix
 * that exists in `src/` is classified here.
 */
export const SECURITY_AUDIT_ACTION_PREFIXES: readonly string[] = [
  'auth.',
  'authz.',
  'security.',
  'account.',
  'family.member.',
  'family.ownership.',
  'consent.',
  // A financial record. The target schedule keeps invoices for seven years for
  // Egyptian and Saudi tax purposes; the audit row that says a subscription was
  // cancelled is part of the same story and must not outlive it by less.
  'billing.',
  // PHASE C P4: «who forced a retention sweep, and when» is precisely the
  // question a compliance review asks years after the fact, and the answer must
  // outlive the ordinary 24 months. Platform-operator actions against the
  // scheduler are therefore security-classified.
  'scheduler.',
];

/**
 * The prefixes that are deliberately ORDINARY — deleted at 24 months.
 *
 * Present as an explicit list rather than as "everything else" so that adding a
 * new audit action forces a decision instead of inheriting one:
 * `test/data-retention/retention-targets.spec.ts` reads every `action` literal
 * in `src/` and fails if one falls outside BOTH lists.
 *
 * `organization.*` is here because it is B2B configuration history on the
 * parallel organisation tenant axis — a record of a setting that was changed,
 * not of a security event or a financial fact — and 24 months is the documented
 * default for exactly that.
 */
export const ORDINARY_AUDIT_ACTION_PREFIXES: readonly string[] = ['organization.'];

function notSecurityAudit(): string {
  return SECURITY_AUDIT_ACTION_PREFIXES.map(
    (p) => `"action" NOT LIKE '${p}%'`,
  ).join(' AND ');
}

/**
 * THE TABLE. Ordered by how sensitive the data is, most sensitive first,
 * because that is the order a reviewer should read it in.
 */
export const RETENTION_TARGETS: readonly RetentionTarget[] = [
  {
    key: 'child_messages',
    table: 'child_messages',
    timeColumn: 'created_at',
    retentionDays: 365,
    mechanism: 'HARD_DELETE',
    tenantScoped: true,
    decision: 'DOCUMENTED_POLICY',
    rationale:
      'A2 DA-016: `child_messages.body` is free text ADDRESSED TO A CHILD, stored unencrypted, with no retention of any kind — it lived forever. The target schedule (docs/05 §5.4) sets AI-authored conversational content at 12 months; this applies the same 12 months to the whole table, including parent-authored messages, because splitting the rule by author would leave the most personal half of a family thread deleted and the other half not, which is worse for a reader than either rule alone.',
  },
  {
    key: 'ai_memory_entries',
    table: 'ai_memory_entries',
    timeColumn: 'updated_at',
    retentionDays: 365,
    mechanism: 'HARD_DELETE',
    tenantScoped: true,
    decision: 'DOCUMENTED_POLICY',
    rationale:
      "The 365-day period is DataRetentionPolicyService's own, declared since Sprint 9 and never executed. Measured on `updated_at`, not `created_at`: a memory the engines keep refreshing is a live inference about a child, and ageing it out from its first write would delete facts the product is still using. NOTE the policy declares method SOFT_DELETE and the table has no `deleted_at` column to soft-delete into — see PC-D-002.",
  },
  {
    key: 'ai_usage_logs',
    table: 'ai_usage_logs',
    timeColumn: 'created_at',
    retentionDays: 180,
    mechanism: 'HARD_DELETE',
    tenantScoped: true,
    decision: 'ENGINEERING_DEFAULT',
    rationale:
      'Per-call provider usage/cost telemetry. Kept long enough to reconcile a billing period and investigate a cost anomaly, and no longer. 180 days matches the analytics anonymisation window already in the policy so operators have one number to remember. Family-attributable rows exist (DA-013 explains why historical rows are NULL), so this is a privacy target and not merely an operational one.',
  },
  {
    key: 'audit_logs_ordinary',
    table: 'audit_logs',
    timeColumn: 'created_at',
    retentionDays: AUDIT_RETENTION_DAYS,
    mechanism: 'HARD_DELETE',
    tenantScoped: true,
    decision: 'DOCUMENTED_POLICY',
    extraPredicate: notSecurityAudit(),
    rationale:
      'Target schedule: audit logs 24 months, security-classified audit logs 7 years. Before this, `audit_logs` had NO retention at all and Decision-063 had explicitly deferred the question; deferring it indefinitely is how an audit table becomes the largest store of personal data in the system. Security rows are excluded by the action-prefix list above and are therefore retained indefinitely today — which is stricter than the 7-year target and deliberately so, since the mechanism to delete them safely is a separate decision.',
  },
  {
    key: 'notifications',
    table: 'notifications',
    timeColumn: 'created_at',
    retentionDays: 90,
    mechanism: 'HARD_DELETE',
    tenantScoped: true,
    decision: 'ENGINEERING_DEFAULT',
    rationale:
      'Already enforced before this step (at 90 days) but never scheduled. KEPT AT 90 rather than raised to the target schedule\'s 180: nothing downstream reads an old notification, and for a child-data product the shorter of two defensible numbers is the right one to default to. The divergence from the written target is recorded as an open decision rather than silently reconciled in either direction — see PC-D-004.',
  },
  {
    key: 'daily_behavioral_snapshots',
    table: 'daily_behavioral_snapshots',
    timeColumn: 'usage_date',
    retentionDays: 90,
    mechanism: 'HARD_DELETE',
    tenantScoped: true,
    decision: 'OPEN_BUSINESS_DECISION',
    rationale:
      'Daily pickup/screen-time counts per child. 90 days is an engineering default, NOT a legal determination; COPPA, GDPR-K and Saudi PDPL each have their own answer and this project has never claimed authority over that question. Enforced before this step, scheduled for the first time by it.',
  },
  {
    key: 'app_usage_logs',
    table: 'app_usage_logs',
    timeColumn: 'usage_date',
    retentionDays: 90,
    mechanism: 'HARD_DELETE',
    tenantScoped: true,
    decision: 'OPEN_BUSINESS_DECISION',
    rationale:
      'Per-app usage minutes for a child. Same 90-day default and the same legal caveat as the snapshots it is written alongside.',
  },
  {
    key: 'consumed_messages',
    table: 'consumed_messages',
    timeColumn: 'consumed_at',
    retentionDays: 90,
    mechanism: 'HARD_DELETE',
    tenantScoped: true,
    decision: 'ENGINEERING_DEFAULT',
    rationale:
      'Consumer idempotency markers. They grow one row per (consumer, event) FOREVER and nothing ever removed one. 90 days is chosen against the only thing that can make deleting one unsafe — a redelivery arriving after the marker is gone — and the outbox reaches DEAD after 8 attempts with capped backoff, i.e. within hours. Ninety days is three orders of magnitude of headroom, and the primary defence against a double-grant is the ledger unique index anyway, never this table (its own docstring says so).',
  },
  {
    key: 'outbox_messages_published',
    table: 'outbox_messages',
    timeColumn: 'published_at',
    retentionDays: 30,
    mechanism: 'HARD_DELETE',
    tenantScoped: true,
    decision: 'ENGINEERING_DEFAULT',
    extraPredicate: `"status" = 'PUBLISHED'`,
    rationale:
      'A delivered message is a receipt, and the receipt for a delivery that happened last quarter has no reader. PENDING, FAILED, PUBLISHING and DEAD are all excluded by the predicate — deleting a DEAD row in particular would destroy the evidence of an undelivered reward announcement, which is the one thing PHASE-C-P0 built the dead-letter surface to preserve.',
  },
  {
    key: 'domain_events',
    table: 'domain_events',
    timeColumn: 'received_at',
    retentionDays: 90,
    mechanism: 'HARD_DELETE',
    tenantScoped: true,
    decision: 'ENGINEERING_DEFAULT',
    extraPredicate:
      'NOT EXISTS (SELECT 1 FROM "outbox_messages" om WHERE om."domain_event_id" = "domain_events"."id" AND om."status" <> \'PUBLISHED\')',
    rationale:
      'The event log grows one row per device event forever. THE PREDICATE IS THE WHOLE SAFETY ARGUMENT: `outbox_messages.domain_event_id` is ON DELETE CASCADE, so deleting a domain event with an undelivered message attached destroys a delivery that was still going to happen — silently, and exactly for the events that are already in trouble. The NOT EXISTS makes an event deletable only once every message derived from it is PUBLISHED. Ninety days also keeps the replay-protection window (`domain_events (family_id, idempotency_key)`) far wider than any client retry.',
  },
];

/** The tables this schedule covers, for the coverage figure the report quotes. */
export const RETENTION_COVERED_TABLES: readonly string[] = [
  ...new Set(RETENTION_TARGETS.map((t) => t.table)),
];
