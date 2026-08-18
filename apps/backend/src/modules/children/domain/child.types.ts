import { Prisma } from '@prisma/client';

/**
 * THE ONE PLACE THAT DECIDES WHAT A CLIENT MAY SEE OF A CHILD.
 *
 * `Child` carries `pinCodeHash` — the child app's login PIN, hashed. A
 * four-digit PIN has ten thousand possible values, so its hash is not a
 * secret in any practical sense: anyone holding it can recover the PIN
 * offline in milliseconds. Returning the raw Prisma row from
 * `GET /children` and `GET /children/:childId` put that hash into HTTP
 * caches, client logs, crash reports and every device the response ever
 * touched. A credential hash must never leave the server, however
 * trusted the recipient.
 *
 * The fix is a WHITELIST, not a deletion at a call site: this select
 * names the columns a client is allowed to receive, so a column added to
 * `Child` tomorrow is NOT exposed unless someone deliberately adds it
 * here. It is applied in the repository, which means the hash is never
 * even read out of PostgreSQL on a client-facing path — there is nothing
 * in memory to leak.
 *
 * Deliberate exclusions:
 *  - `pinCodeHash` — the credential. See `IChildWithPinCredential` below
 *    for the one path that may read it.
 *  - `deletedAt` — soft-delete bookkeeping. Every client-facing query
 *    already filters `deletedAt: null`, so it is a constant `null` on the
 *    wire: internal state with no job to do on a parent's screen.
 *
 * `familyId` IS included, deliberately. It is the caller's OWN family id
 * — every route in this module is scoped to `familyId` taken from the
 * verified access token, so the client already holds it — and the Parent
 * App reads it off the child row to open the family store
 * (`dashboard_home_screen.dart`). Removing it would break a shipped
 * client to hide a value that client already knows.
 */
export const CHILD_CLIENT_SELECT = {
  id: true,
  familyId: true,
  firstName: true,
  lastName: true,
  dateOfBirth: true,
  gender: true,
  avatarUrl: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.ChildSelect;

/**
 * A child as anything outside the repository is allowed to see them.
 * DERIVED from the select above rather than restated, so the type and the
 * query can never drift apart — adding a key to `CHILD_CLIENT_SELECT` is
 * the only way to widen either.
 */
export type IChildView = Prisma.ChildGetPayload<{ select: typeof CHILD_CLIENT_SELECT }>;

/**
 * The child PLUS the PIN hash — for verifying a child-app login, and for
 * nothing else. Named so that "am I about to hand a credential to a
 * client?" is answerable by reading the call site. Reachable only through
 * `ChildrenService.getChildWithPinCredentialOrThrow`, which no controller
 * calls.
 */
export type IChildWithPinCredential = IChildView & { pinCodeHash: string | null };

export interface ICreateChildInput {
  firstName: string;
  lastName?: string;
  dateOfBirth: string; // ISO date string, e.g. "2015-06-01"
  gender?: string;
  avatarUrl?: string;
}

export interface IUpdateChildInput {
  firstName?: string;
  lastName?: string;
  dateOfBirth?: string;
  gender?: string;
  avatarUrl?: string;
  isActive?: boolean;
}

