import type { OperatorRole } from '@prisma/client';

/**
 * ===========================================================================
 * WHAT A MEMBER OF STAFF MAY DO — as a closed vocabulary, not as a role check.
 * ===========================================================================
 *
 * Before this file the answer was one bit: hold `INTERNAL_ADMIN_API_KEY` and
 * you may do all forty-five things. A support agent reading a ticket held the
 * same secret that edits prices and suspends households.
 *
 * ── WHY PERMISSIONS AND NOT `if (role === 'SUPER_ADMIN')` ──────────────
 *
 * A role check scattered across handlers is a policy that exists in forty-five
 * places and can be read in none. The set below is the whole policy, in one
 * file, and `permissions.spec.ts` asserts properties OF IT rather than of any
 * handler: that READ_ONLY holds no write, that only SAFETY may read a child's
 * safety content, that every role's grant is a subset of SUPER_ADMIN's.
 *
 * ── THE NAMING RULE, WHICH IS LOad-BEARING ─────────────────────────────
 *
 * `<domain>.<verb>`, and READ IS ALWAYS ITS OWN PERMISSION, never implied by a
 * write. `safety.review` does not include `safety.read_content`, because those
 * are two different questions — one is «may this person act on an alert» and
 * the other is «may this person see what a distressed child wrote» — and a
 * product for children may not answer the second by accident while answering
 * the first.
 *
 * ── FOUR ROLES, AND THE THREE THAT ARE MISSING ON PURPOSE ──────────────
 *
 * `OPERATIONS`, `BILLING` and `ANALYST` were specified and are not here. A role
 * with no holder is a matrix nobody exercises and no test defends. Adding one
 * is a single entry in `ROLE_PERMISSIONS` below, and the exhaustiveness test
 * fails until it is written — which is the point.
 */

export const PERMISSIONS = [
  // -- households -----------------------------------------------------------
  'families.read',
  'families.suspend',
  // -- children and devices -------------------------------------------------
  'children.read',
  'devices.read',
  'devices.revoke',
  // -- child safety ---------------------------------------------------------
  /** The queue: category, severity, when, which household. NOT the content. */
  'safety.read',
  /**
   * The alert's title and description — words about a distressed child.
   * SEPARATE FROM `safety.read` because the queue is a workload and the
   * content is a person's private difficulty, and the second is not a
   * convenience granted by the first.
   */
  'safety.read_content',
  'safety.review',
  'safety.escalate',
  // -- money ----------------------------------------------------------------
  'billing.read',
  'billing.grant',
  'billing.catalogue.write',
  // -- platform -------------------------------------------------------------
  'jobs.read',
  'jobs.run',
  'outbox.read',
  'outbox.retry',
  'notifications.read',
  'feature_flags.read',
  'feature_flags.update',
  'ai.read',
  'support.read',
  'audit.read',
  // -- staff ----------------------------------------------------------------
  /**
   * SEEING AND ENDING YOUR OWN SESSION. Held by EVERY role, because it is not a
   * privilege — it is the ability to look at your own badge and hand it back.
   * It was originally folded into `operators.read`, and the consequence was
   * found by review rather than by a test: SAFETY and SUPPORT could not call
   * `GET /me` (so the console could not render for them) and could not call
   * `DELETE /session` (so their eight-hour token could not be ended by the
   * person holding it). The safety desk is the primary user of this console.
   */
  'operators.self',
  /** The staff DIRECTORY — other people's identities. Genuinely privileged. */
  'operators.read',
  'operators.manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** Every permission whose name is a read. Used by the tests, and by the
 * READ_ONLY grant below, so the two cannot drift apart. */
export const READ_PERMISSIONS: readonly Permission[] = PERMISSIONS.filter(
  (p) => p.endsWith('.read') || p.endsWith('.read_content'),
);

/**
 * NOT A PRIVILEGE OVER ANYBODY — what a person may do to their OWN session, and
 * nothing else. Held by every role, and named as a set for one reason: the
 * matrix tests classify a permission as a «write» by elimination (anything that
 * is not a read), and `operators.self` is neither. Without this set,
 * «READ_ONLY writes nothing» would either be false or would have to be softened
 * into an assertion about names.
 *
 * Anything added here must be true of the WEAKEST role in the system. If a
 * candidate is not something an auditor with no other access may do, it does not
 * belong in this list.
 */
export const SELF_PERMISSIONS: readonly Permission[] = ['operators.self'];

/**
 * THE MATRIX. Deliberately written out rather than derived, because a derived
 * matrix is one whose exceptions live in the derivation.
 */
export const ROLE_PERMISSIONS: Readonly<Record<OperatorRole, readonly Permission[]>> = {
  /** Everything. The only role that may create or revoke another operator. */
  SUPER_ADMIN: PERMISSIONS,

  /**
   * The support desk. Reads households, works the queue, and may see that a
   * safety alert EXISTS — so that «my child's alert was ignored» can be
   * answered — but never what it says. Suspends nothing, grants nothing,
   * changes no price.
   */
  SUPPORT: [
    'operators.self',
    'families.read',
    'children.read',
    'devices.read',
    'safety.read',
    'billing.read',
    'notifications.read',
    'support.read',
    'jobs.read',
    'outbox.read',
    'ai.read',
  ],

  /**
   * The child-safety desk. The ONLY role that may read an alert's content, and
   * the only one that may act on it. Deliberately holds no billing permission
   * at all: the person who reads a child's distress has no business in the
   * household's money, and keeping those two apart is what makes the content
   * permission defensible.
   */
  SAFETY: [
    'operators.self',
    'families.read',
    'children.read',
    'devices.read',
    'safety.read',
    'safety.read_content',
    'safety.review',
    'safety.escalate',
    'support.read',
    'notifications.read',
  ],

  /**
   * Reads, everywhere, and writes nowhere — including no `safety.read_content`.
   * An auditor needs to see that the safety queue is being worked, not what is
   * in it.
   */
  READ_ONLY: ['operators.self', ...READ_PERMISSIONS.filter((p) => p !== 'safety.read_content')],
};

/**
 * EVERY OPERATOR ROLE, DERIVED FROM THE MATRIX ITSELF — so a route that
 * validates a role and the file that grants permissions to roles cannot drift.
 *
 * It is exported from HERE rather than written out at the call site for a second
 * reason as well: `role-model.spec.ts` forbids any file outside `common/authz`
 * from naming a bare `'SUPPORT'` string, because the FAMILY role of that name is
 * a declared-but-unbuilt console. The operator role that shares the name is a
 * different enum entirely, and importing this constant keeps that ratchet
 * meaningful instead of teaching it an exception.
 */
export const OPERATOR_ROLES = Object.keys(ROLE_PERMISSIONS) as readonly OperatorRole[];

/** The one question a guard asks. */
export function roleHasPermission(role: OperatorRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
