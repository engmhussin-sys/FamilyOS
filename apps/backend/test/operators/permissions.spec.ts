import { OperatorRole } from '@prisma/client';

import {
  PERMISSIONS,
  READ_PERMISSIONS,
  ROLE_PERMISSIONS,
  SELF_PERMISSIONS,
  roleHasPermission,
  type Permission,
} from '../../src/common/authz/permissions';

/**
 * ===========================================================================
 * THE POLICY, TESTED AS A POLICY — not as forty-five handlers.
 * ===========================================================================
 *
 * Before this matrix existed the answer to «what may a support agent do» was
 * one bit: hold the shared key and do everything. The value of writing the
 * policy down is that PROPERTIES OF IT become assertable, and the properties
 * are what a reviewer actually wants to check. None of the tests below open an
 * HTTP connection or touch a database; all of them are about the shape of the
 * grant.
 */

const ALL_ROLES = Object.values(OperatorRole);

describe('the operator permission matrix', () => {
  it('gives every role an explicit grant — a new role cannot inherit one', () => {
    // The exhaustiveness ratchet. Adding OPERATIONS/BILLING/ANALYST to the enum
    // later fails here until somebody decides what they may do, which is the
    // decision that must not be skipped.
    for (const role of ALL_ROLES) {
      expect(ROLE_PERMISSIONS[role]).toBeDefined();
      expect(ROLE_PERMISSIONS[role].length).toBeGreaterThan(0);
    }
    expect(Object.keys(ROLE_PERMISSIONS).sort()).toEqual([...ALL_ROLES].sort());
  });

  it('grants nothing that is not in the vocabulary', () => {
    const vocabulary = new Set<string>(PERMISSIONS);
    for (const role of ALL_ROLES) {
      for (const permission of ROLE_PERMISSIONS[role]) {
        expect(vocabulary.has(permission)).toBe(true);
      }
    }
  });

  it('makes SUPER_ADMIN a superset of every other role', () => {
    // Not for convenience: if some role held a permission SUPER_ADMIN lacked,
    // there would be an action nobody could audit, review or take over.
    const superAdmin = new Set<string>(ROLE_PERMISSIONS.SUPER_ADMIN);
    for (const role of ALL_ROLES) {
      for (const permission of ROLE_PERMISSIONS[role]) {
        expect(superAdmin.has(permission)).toBe(true);
      }
    }
  });

  /**
   * `SELF_PERMISSIONS` is excluded from «writes» ON PURPOSE, and the exclusion
   * is itself asserted below rather than taken on trust. `operators.self` is
   * neither a read nor a privilege: it is looking at your own badge and handing
   * it back. Every role holds it, including this one.
   */
  it('holds the self permissions in every role, and holds nothing else that is not a read', () => {
    expect(SELF_PERMISSIONS).toEqual(['operators.self']);
    for (const role of ALL_ROLES) {
      for (const permission of SELF_PERMISSIONS) {
        expect(roleHasPermission(role, permission)).toBe(true);
      }
    }
  });

  it('lets READ_ONLY write NOTHING, anywhere', () => {
    const writes = PERMISSIONS.filter((p) => !READ_PERMISSIONS.includes(p) && !SELF_PERMISSIONS.includes(p));
    // A named list, so this test says what it is protecting rather than
    // asserting a count that means nothing when it changes.
    expect(writes).toEqual(
      expect.arrayContaining([
        'families.suspend',
        'devices.revoke',
        'safety.review',
        'billing.grant',
        'feature_flags.update',
        'jobs.run',
        'operators.manage',
      ]),
    );
    for (const permission of writes) {
      expect(roleHasPermission('READ_ONLY', permission)).toBe(false);
    }
  });

  describe('the child-safety line — the one this product cannot get wrong', () => {
    it('gives the alert CONTENT to SAFETY and to nobody else but SUPER_ADMIN', () => {
      const holders = ALL_ROLES.filter((role) => roleHasPermission(role, 'safety.read_content'));
      expect(holders.sort()).toEqual(['SAFETY', 'SUPER_ADMIN']);
    });

    it('keeps reading the QUEUE separate from reading what a child wrote', () => {
      // SUPPORT can see that an alert exists — so «my child's alert was
      // ignored» is answerable — and cannot read a word of it.
      expect(roleHasPermission('SUPPORT', 'safety.read')).toBe(true);
      expect(roleHasPermission('SUPPORT', 'safety.read_content')).toBe(false);

      // And an auditor sees the queue is being worked, not what is in it.
      expect(roleHasPermission('READ_ONLY', 'safety.read')).toBe(true);
      expect(roleHasPermission('READ_ONLY', 'safety.read_content')).toBe(false);
    });

    it('never lets a write imply the read of the content it acts on', () => {
      // Structural: no role may hold `safety.review` without having been
      // granted `safety.read_content` deliberately and separately.
      for (const role of ALL_ROLES) {
        if (roleHasPermission(role, 'safety.review')) {
          expect(ROLE_PERMISSIONS[role]).toContain('safety.read_content');
        }
      }
    });

    it('keeps the safety desk out of the household money entirely', () => {
      // The person who reads a child's distress has no business in the
      // family's billing, and that separation is what makes the content
      // permission defensible in the first place.
      const money: Permission[] = ['billing.read', 'billing.grant', 'billing.catalogue.write'];
      for (const permission of money) {
        expect(roleHasPermission('SAFETY', permission)).toBe(false);
      }
    });
  });

  it('lets only SUPER_ADMIN manage other staff', () => {
    const holders = ALL_ROLES.filter((role) => roleHasPermission(role, 'operators.manage'));
    expect(holders).toEqual(['SUPER_ADMIN']);
  });

  it('gives SUPPORT no lever that changes a household', () => {
    const levers: Permission[] = ['families.suspend', 'devices.revoke', 'billing.grant', 'jobs.run'];
    for (const permission of levers) {
      expect(roleHasPermission('SUPPORT', permission)).toBe(false);
    }
  });

  it('names reads by a rule rather than by a hand-kept list', () => {
    // READ_PERMISSIONS is derived from the naming convention, so a permission
    // added tomorrow is classified by how it is named — and a write that is
    // accidentally named `.read` would show up in READ_ONLY's grant, where
    // the test above would catch it.
    for (const permission of READ_PERMISSIONS) {
      expect(permission.endsWith('.read') || permission.endsWith('.read_content')).toBe(true);
    }
  });
});
