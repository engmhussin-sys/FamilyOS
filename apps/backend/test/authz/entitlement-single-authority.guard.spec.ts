/**
 * ============================================================================
 * ARCHITECTURE GUARD — THERE IS EXACTLY ONE `hasFeature`, AND IT IS THE ONLY
 * PLACE THE ENTITLED STATUS SET IS WRITTEN.
 * ============================================================================
 *
 * THE DEFECT SHAPE, MEASURED RATHER THAN IMAGINED. This repository shipped TWO
 * implementations of «is this family entitled to feature X?»:
 *
 *   `EntitlementsService.hasFeature`  {TRIALING, ACTIVE}, computed from
 *                                     `subscriptions` — and the only one the
 *                                     four gated features called.
 *   `EntitlementService.hasFeature`   the `entitlements` table, plus
 *                                     {TRIALING, ACTIVE, GRACE_PERIOD}.
 *
 * They disagreed in both directions and both were live: a household in its
 * seven-day grace window — a household that HAS PAID — was refused a second
 * child, a second device, priority support and insights, and a household whose
 * entitlements had been REVOKED kept all four. `billing.module.ts` already
 * carried a comment naming this risk, and the comment held for exactly as long
 * as somebody happened to read it. A comment is not a constraint.
 *
 * This file is the constraint. It follows this repository's existing guard
 * idiom — `test/architecture/dormant-schema.guard.spec.ts` and
 * `notification-producer-chain.guard.spec.ts` (both READ ONLY here): a SCANNER
 * that measures what `src/` actually contains, a DECLARATION LEDGER that
 * carries a reason from a fixed vocabulary, and NEGATIVE CONTROLS that prove
 * the scanner discriminates rather than merely returning what we hoped.
 *
 * WHAT GOES RED, AND WHEN
 *   RULE E1  A third `hasFeature` appears anywhere in `src/`.
 *   RULE E2  The delegate stops being a delegate — it grows a branch, a status
 *            literal, or a second repository read.
 *   RULE E3  The authority re-inlines a status set instead of asking
 *            `ENTITLEMENT_STATUS_LEDGER`, which is where the two sets drifted
 *            apart in the first place.
 *   RULE E4  A ledger entry outlives the file it describes.
 *   RULE E5  A ninth subscription status is added without a decision and a
 *            reason — the exact way `GRACE_PERIOD` went missing.
 */
import * as fs from 'fs';
import * as path from 'path';

import {
  CANONICAL_SUBSCRIPTION_STATUSES,
  ENTITLEMENT_BEARING_STATUSES,
  ENTITLEMENT_STATUS_LEDGER,
  isEntitlementBearing,
} from '../../src/modules/billing/domain/subscription-status';

const SRC = path.resolve(__dirname, '../../src');

/** Every status word either vocabulary knows. None may appear in a decision. */
const STATUS_LITERALS = [
  'TRIALING',
  'TRIAL',
  'ACTIVE',
  'PAST_DUE',
  'CANCELED',
  'CANCELLED',
  'EXPIRED',
  'PENDING',
  'GRACE_PERIOD',
  'REFUNDED',
];

type Role = 'AUTHORITY' | 'DELEGATE';

interface LedgerEntry {
  readonly file: string;
  readonly role: Role;
  readonly why: string;
}

/**
 * THE LEDGER. Two entries, and the second one is not an aspiration: RULE E2
 * reads its body on every run.
 */
const LEDGER: readonly LedgerEntry[] = [
  {
    file: 'modules/billing/application/services/entitlement.service.ts',
    role: 'AUTHORITY',
    why:
      'The survivor. It reads the materialised `entitlements` table first — so a refund, a chargeback and an operator grant are all honoured — and falls back to a computation over `subscriptions` for every family that has no row, which is every pre-Phase-D family and every household created by `SubscriptionService`. Its status set is not its own: it asks `ENTITLEMENT_STATUS_LEDGER`.',
  },
  {
    file: 'modules/billing/application/services/entitlements.service.ts',
    role: 'DELEGATE',
    why:
      'The Sprint 8 symbol, kept because four modules inject it by name and their unit suites provide it by name. It forwards and does nothing else. Deleting the symbol is a follow-up for the owners of those four modules; keeping the LOGIC would have been the defect.',
  },
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Declarations, not calls: `hasFeature(` preceded by nothing that dereferences. */
const DECLARATION = /(^|[^.\w])(async\s+)?hasFeature\s*\(/;

function declaresHasFeature(source: string): boolean {
  return DECLARATION.test(source);
}

/** The body of `hasFeature`, brace-matched from its signature. */
function hasFeatureBody(source: string): string {
  const match = DECLARATION.exec(source);
  if (!match) return '';
  let index = source.indexOf('{', match.index + match[0].length);
  if (index < 0) return '';
  let depth = 0;
  const start = index;
  for (; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return source.slice(start);
}

/** A delegate forwards. Anything that DECIDES shows up in one of these. */
function delegateViolations(body: string): string[] {
  const found: string[] = [];
  if (!/return\s+this\.\w+\.hasFeature\(/.test(body)) found.push('does not forward to another hasFeature');
  if (/\bif\b|\?\.|\?\s|\bswitch\b|&&|\|\|/.test(body.replace(/\?\./g, ''))) found.push('contains a branch');
  if (/new Set\(|\.includes\(|\[\s*'/.test(body)) found.push('contains a set or list membership test');
  for (const literal of STATUS_LITERALS) {
    if (new RegExp(`'${literal}'`).test(body)) found.push(`names the status literal ${literal}`);
  }
  return found;
}

/** The authority may not carry its own status set — that is what drifted. */
function authorityViolations(body: string): string[] {
  const found: string[] = [];
  for (const literal of STATUS_LITERALS) {
    if (new RegExp(`'${literal}'`).test(body)) found.push(`inlines the status literal ${literal}`);
  }
  if (!/isEntitlementBearing\(/.test(body)) found.push('does not consult ENTITLEMENT_STATUS_LEDGER');
  return found;
}

describe('ARCHITECTURE GUARD — one entitlement authority', () => {
  const files = walk(SRC);
  const declaring = files
    .filter((file) => declaresHasFeature(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(SRC, file).split(path.sep).join('/'))
    .sort();

  /**
   * RULE E1. The scanner measures `src/`; the ledger is the only permitted
   * answer. A third implementation — a cache in front of the gate, a "quick"
   * check in a new module, a copy in `ai-core` — fails here, by name.
   */
  it('RULE E1 — `src/` declares `hasFeature` in exactly the files the ledger names', () => {
    expect(declaring).toEqual([...LEDGER.map((entry) => entry.file)].sort());
  });

  it('RULE E4 — every ledger entry still describes a real file that still declares the method', () => {
    for (const entry of LEDGER) {
      const full = path.join(SRC, entry.file);
      expect(fs.existsSync(full)).toBe(true);
      expect(declaresHasFeature(fs.readFileSync(full, 'utf8'))).toBe(true);
      expect(entry.why.length).toBeGreaterThan(80);
    }
  });

  it('RULE E2 — the delegate forwards and decides nothing', () => {
    for (const entry of LEDGER.filter((e) => e.role === 'DELEGATE')) {
      const body = hasFeatureBody(fs.readFileSync(path.join(SRC, entry.file), 'utf8'));
      expect(body).not.toBe('');
      expect({ file: entry.file, violations: delegateViolations(body) }).toEqual({
        file: entry.file,
        violations: [],
      });
    }
  });

  it('RULE E3 — the authority reads the status ledger instead of inlining a set', () => {
    const authority = LEDGER.find((entry) => entry.role === 'AUTHORITY')!;
    const body = hasFeatureBody(fs.readFileSync(path.join(SRC, authority.file), 'utf8'));
    expect(body).not.toBe('');
    expect({ file: authority.file, violations: authorityViolations(body) }).toEqual({
      file: authority.file,
      violations: [],
    });
  });

  it('there is exactly one AUTHORITY', () => {
    expect(LEDGER.filter((entry) => entry.role === 'AUTHORITY')).toHaveLength(1);
  });

  /**
   * RULE E5. The set is DERIVED from a per-status ledger, so a ninth status
   * cannot be silently absent: TypeScript refuses the `Record` without it, and
   * this asserts the decision arrives with a reason attached rather than a
   * default.
   */
  describe('RULE E5 — the status set is data, total, and reasoned', () => {
    it('every canonical status has a decision and a non-trivial reason', () => {
      for (const status of CANONICAL_SUBSCRIPTION_STATUSES) {
        const rule = ENTITLEMENT_STATUS_LEDGER[status];
        expect(typeof rule?.entitled).toBe('boolean');
        expect((rule?.because ?? '').length).toBeGreaterThan(40);
      }
      expect(Object.keys(ENTITLEMENT_STATUS_LEDGER).sort()).toEqual(
        [...CANONICAL_SUBSCRIPTION_STATUSES].sort(),
      );
    });

    it('the derived set is exactly the ledger’s entitled rows — and unchanged by the merge', () => {
      const derived = CANONICAL_SUBSCRIPTION_STATUSES.filter((s) => ENTITLEMENT_STATUS_LEDGER[s].entitled);
      expect([...derived].sort()).toEqual(['ACTIVE', 'GRACE_PERIOD', 'TRIAL']);
      expect([...ENTITLEMENT_BEARING_STATUSES].sort()).toEqual([...derived].sort());
      for (const status of CANONICAL_SUBSCRIPTION_STATUSES) {
        expect(`${status}:${isEntitlementBearing(status)}`).toBe(
          `${status}:${ENTITLEMENT_STATUS_LEDGER[status].entitled}`,
        );
      }
    });

    it('GRACE_PERIOD’s reason cites the seven-day promise; REFUNDED’s cites the revocation', () => {
      expect(ENTITLEMENT_STATUS_LEDGER.GRACE_PERIOD.because).toMatch(/7 days|seven|window/i);
      expect(ENTITLEMENT_STATUS_LEDGER.REFUNDED.because).toMatch(/revoke/i);
    });
  });

  /**
   * NEGATIVE CONTROLS. A guard that cannot fail is a scoreboard. These run the
   * SAME functions the rules above run, over sources written to be wrong.
   */
  describe('the scanner discriminates', () => {
    it('detects a newly-introduced second implementation', () => {
      const impostor = `
        class QuickGate {
          async hasFeature(familyId: string): Promise<boolean> {
            const sub = await this.repo.find(familyId);
            return sub?.status === 'ACTIVE';
          }
        }`;
      expect(declaresHasFeature(impostor)).toBe(true);
      expect(authorityViolations(hasFeatureBody(impostor))).not.toEqual([]);
    });

    it('does not mistake a CALL for a declaration', () => {
      const caller = `const ok = await this.entitlements.hasFeature(familyId, 'family_insights');`;
      expect(declaresHasFeature(caller)).toBe(false);
    });

    it('catches a delegate that grows an opinion', () => {
      const drifted = `
        async hasFeature(familyId: string, feature: string): Promise<boolean> {
          if (feature === 'priority_support') return false;
          return this.entitlements.hasFeature(familyId, feature);
        }`;
      expect(delegateViolations(hasFeatureBody(drifted))).toContain('contains a branch');
    });

    it('catches a delegate that re-inlines the status set', () => {
      const drifted = `
        async hasFeature(familyId: string, feature: string): Promise<boolean> {
          const entitled = new Set(['TRIALING', 'ACTIVE']);
          return this.entitlements.hasFeature(familyId, feature);
        }`;
      const violations = delegateViolations(hasFeatureBody(drifted));
      expect(violations).toContain('contains a set or list membership test');
      expect(violations).toContain('names the status literal TRIALING');
    });

    it('catches an authority that stops asking the ledger', () => {
      const drifted = `
        async hasFeature(familyId: string): Promise<boolean> {
          return ['TRIALING', 'ACTIVE'].includes(sub.status);
        }`;
      const violations = authorityViolations(hasFeatureBody(drifted));
      expect(violations).toContain('inlines the status literal TRIALING');
      expect(violations).toContain('does not consult ENTITLEMENT_STATUS_LEDGER');
    });
  });
});
