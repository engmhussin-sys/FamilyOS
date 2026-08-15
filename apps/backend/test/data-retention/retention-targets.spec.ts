/**
 * PHASE C P4 — THE RETENTION SCHEDULE IS CHECKED AGAINST THE REAL SCHEMA AND
 * AGAINST THE REAL AUDIT VOCABULARY.
 *
 * A retention table is the kind of artefact that rots quietly: a table gets
 * renamed, a column gets dropped, a new security-classified audit action gets
 * added, and the sweep either starts failing every night or — far worse —
 * starts deleting something it should have kept. Both failure modes are caught
 * here, statically, against `schema.prisma` and against `src/` itself.
 *
 * THE AUDIT-ACTION TEST IS THE ONE THAT MATTERS MOST. `audit_logs` is swept at
 * 24 months EXCEPT for security-classified rows, and the classification is a
 * prefix list rather than a column (see `retention-targets.ts` for why, and for
 * the follow-up). A prefix list has exactly one way to go wrong: somebody adds
 * `security.break_glass.closed` and forgets it, at which point a security
 * record is deleted at 24 months instead of retained. So this reads every
 * `action:` literal that exists in `src/` and requires each one to be
 * classified deliberately — as security-retained or as ordinary — with no
 * third, accidental category.
 */
import * as fs from 'fs';
import * as path from 'path';

import {
  RETENTION_COVERED_TABLES,
  ORDINARY_AUDIT_ACTION_PREFIXES,
  RETENTION_TARGETS,
  SECURITY_AUDIT_ACTION_PREFIXES,
} from '../../src/modules/data-retention/domain/retention-targets';

const ROOT = path.resolve(__dirname, '../..');
const SCHEMA = fs.readFileSync(path.join(ROOT, 'prisma/schema.prisma'), 'utf8');

/** Column names of a table, read from the `@@map`ped model block in schema.prisma. */
function columnsOf(table: string): Set<string> {
  const block = SCHEMA.match(
    new RegExp(`^model \\w+ \\{([\\s\\S]*?@@map\\("${table}"\\)[\\s\\S]*?)^\\}`, 'm'),
  );
  if (!block) throw new Error(`No model in schema.prisma maps to table "${table}"`);
  const columns = new Set<string>();
  for (const line of block[1].split('\n')) {
    const mapped = line.match(/@map\("([a-z_0-9]+)"\)/);
    if (mapped) {
      columns.add(mapped[1]);
      continue;
    }
    const bare = line.match(/^\s{2}(\w+)\s+\w/);
    // A field with no @map is stored under its own (already snake-ish) name.
    if (bare) columns.add(bare[1]);
  }
  return columns;
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (entry.isFile() && full.endsWith('.ts')) acc.push(full);
  }
  return acc;
}

describe('PHASE C P4 — retention targets', () => {
  it('names only tables that exist in schema.prisma', () => {
    for (const target of RETENTION_TARGETS) {
      expect(() => columnsOf(target.table)).not.toThrow();
    }
  });

  it('measures age on a column that exists on that table', () => {
    for (const target of RETENTION_TARGETS) {
      expect(columnsOf(target.table).has(target.timeColumn)).toBe(true);
    }
  });

  it('claims `tenantScoped` only for tables that really have a family_id', () => {
    // The sweep binds `family_id = $2` when this flag is set. A wrong flag is a
    // statement that fails at 02:00 with a column-does-not-exist error, in the
    // one job nobody is watching.
    for (const target of RETENTION_TARGETS) {
      expect(columnsOf(target.table).has('family_id')).toBe(target.tenantScoped);
    }
  });

  it('gives every target a positive period, a mechanism and a real rationale', () => {
    for (const target of RETENTION_TARGETS) {
      expect(target.retentionDays).toBeGreaterThan(0);
      expect(['HARD_DELETE', 'ANONYMIZE']).toContain(target.mechanism);
      // A rationale short enough to be a label is a rationale nobody wrote.
      expect(target.rationale.length).toBeGreaterThan(120);
      expect(['DOCUMENTED_POLICY', 'ENGINEERING_DEFAULT', 'OPEN_BUSINESS_DECISION']).toContain(
        target.decision,
      );
    }
  });

  it('has no duplicate keys and no duplicate (table, predicate) pair', () => {
    const keys = RETENTION_TARGETS.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
    const pairs = RETENTION_TARGETS.map((t) => `${t.table}|${t.extraPredicate ?? ''}`);
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it('covers materially more than the five tables A2 measured', () => {
    // A2 §9.1: «التغطية: 5 جداول من 60 (8%)». This is the number that has to
    // move, and it is asserted rather than claimed.
    expect(RETENTION_COVERED_TABLES.length).toBeGreaterThanOrEqual(10);
  });

  it('never deletes an outbox message that has not been delivered', () => {
    const outbox = RETENTION_TARGETS.find((t) => t.table === 'outbox_messages');
    expect(outbox).toBeDefined();
    // Losing a DEAD row destroys the evidence of an undelivered reward
    // announcement — the exact thing PHASE-C-P0's dead-letter surface exists to
    // preserve.
    expect(outbox?.extraPredicate).toContain(`"status" = 'PUBLISHED'`);
  });

  it('never deletes a domain event that still has an undelivered message attached', () => {
    const events = RETENTION_TARGETS.find((t) => t.table === 'domain_events');
    expect(events?.extraPredicate).toContain('NOT EXISTS');
    expect(events?.extraPredicate).toContain('outbox_messages');
    // `outbox_messages.domain_event_id` is ON DELETE CASCADE, so without this
    // predicate the sweep would silently destroy pending deliveries.
    expect(events?.extraPredicate).toContain(`om."status" <> 'PUBLISHED'`);
  });

  describe('audit-log security classification', () => {
    /** Every `action: '...'` literal written anywhere in src/. */
    const actions = (() => {
      const found = new Set<string>();
      for (const file of walk(path.join(ROOT, 'src'))) {
        const text = fs.readFileSync(file, 'utf8');
        for (const m of text.matchAll(/action:\s*'([a-z][a-z0-9._]*)'/g)) found.add(m[1]);
      }
      return [...found].sort();
    })();

    it('finds the audit actions this codebase actually writes', () => {
      // A guard on the guard: if this ever finds nothing, the regex has drifted
      // and every assertion below would pass vacuously.
      expect(actions.length).toBeGreaterThan(5);
    });

    it('classifies every audit action deliberately — security-retained or ordinary', () => {
      const isSecurity = (a: string): boolean =>
        SECURITY_AUDIT_ACTION_PREFIXES.some((p) => a.startsWith(p));

      const isOrdinary = (a: string): boolean =>
        ORDINARY_AUDIT_ACTION_PREFIXES.some((p) => a.startsWith(p));

      // NO THIRD CATEGORY. An action that is in neither list has inherited the
      // 24-month deletion by accident, which for a security record is the one
      // direction this project cannot afford to err in.
      const unclassified = actions.filter((a) => !isSecurity(a) && !isOrdinary(a));
      expect(unclassified).toEqual([]);

      // And the two lists must not overlap, or the predicate would be ambiguous.
      expect(actions.filter((a) => isSecurity(a) && isOrdinary(a))).toEqual([]);

      // The set that would actually be DELETED at 24 months today, asserted as
      // an exact list: growing it is a decision somebody has to make on purpose.
      expect(actions.filter(isOrdinary)).toEqual([
        'organization.branding_updated',
        'organization.campaign_created',
        'organization.created',
        'organization.invitation_accepted',
        'organization.member_invited',
        'organization.policy_set',
      ]);
    });

    it('retains everything auth-, authz- and consent-related beyond 24 months', () => {
      for (const action of [
        'auth.login',
        'auth.refresh_reuse_detected',
        'authz.break_glass.opened',
      ]) {
        expect(SECURITY_AUDIT_ACTION_PREFIXES.some((p) => action.startsWith(p))).toBe(true);
      }
    });

    it('builds a predicate that excludes every security prefix from the sweep', () => {
      const audit = RETENTION_TARGETS.find((t) => t.key === 'audit_logs_ordinary');
      expect(audit).toBeDefined();
      for (const prefix of SECURITY_AUDIT_ACTION_PREFIXES) {
        expect(audit?.extraPredicate).toContain(`"action" NOT LIKE '${prefix}%'`);
      }
      // 730 days = 24 months, the target schedule's own number.
      expect(audit?.retentionDays).toBe(730);
    });
  });
});
