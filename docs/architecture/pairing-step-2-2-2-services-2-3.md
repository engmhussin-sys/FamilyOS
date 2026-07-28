# Sprint 1 Continuation — Decision-065/066 Correction + Services 2 & 3

## 1. Decision-065/066: `childId` required, `deviceId` optional

Applied directly, no redesign, per the explicit "patch and continue"
instruction:
- `schema.prisma`: `DevicePairingEvent.childId` is now required;
  `deviceId` remains nullable, documented as the secondary reference.
- Every type/port/service/repository signature updated to match:
  `childId: string` (required), `deviceId?: string` (optional).
- New: `DEVICE_REQUIRED_EVENTS` (`pairing-transitions.table.ts`) — an
  explicit set enumerating exactly which events require `deviceId`
  (`DEVICE_REGISTERED`, `DEVICE_VERIFIED`, `CAPABILITIES_UPLOADED`,
  `POLICY_ASSIGNED`, `DEVICE_ACTIVATED`, `DEVICE_REVOKED`, etc.) — a real
  gap Case 4 surfaced: the service previously validated *state*
  transitions but not *device-presence* requirements for device-scoped
  events.

**One deliberate deviation from the reviewer's example Event Matrix,
stated plainly:** `PARENT_CONFIRMED` is listed in that matrix as
`deviceId: Null`, but in this project's actual approved sequence
(`pairing-state-machine.md` §4) it occurs *after* `DEVICE_REGISTERED`,
so a `deviceId` is normally already available by then. Rather than
forbidding it, `PARENT_CONFIRMED` is simply not in
`DEVICE_REQUIRED_EVENTS` — `deviceId` is optional-but-typically-present
for it, not required and not rejected. This preserves both the
reviewer's literal matrix (nothing enforces its presence) and the
already-tested, already-approved happy-path sequence (nothing forbids
it either).

Test cases delivered exactly as specified: Case 1 (`PAIRING_INVITED`,
`deviceId` null, succeeds), Case 2 (`PAIRING_ACCEPTED`, `deviceId` null,
succeeds), Case 3 (`DEVICE_REGISTERED` with `deviceId`, succeeds), Case 4
(`DEVICE_REGISTERED` without `deviceId`, rejected) — plus the same check
extended to `DEVICE_ACTIVATED`/`DEVICE_REVOKED` for coverage beyond the
one example event named in Case 4.

## 2. Service 2 — Invitation Service

Redis-backed (unchanged TTL/one-time-use design from the original
`PairingService`), family-ownership-checked
(`ChildrenService.assertChildBelongsToFamily` — the established pattern),
and the first real caller of `PairingStateMachineService.transition()`
with actual `childId` values: `createInvitation` fires `PAIRING_INVITED`,
`redeemInvitation` fires `PAIRING_ACCEPTED`. Both the Redis ticket and
the Postgres audit trail are written from the same service call, keeping
them in lockstep rather than as two independently-updated systems a
caller would have to remember to keep in sync.

## 3. Service 3 — Registration Token Service

Decision-054's third token type, implemented as: `randomBytes(32)` (a
64-hex-char opaque bearer token) → SHA-256-hashed before ever touching
Redis (mirroring `TokenService`'s refresh-token-hashing precedent) → 5
minute TTL → `getAndDelete` for atomic single-use consumption. The
single-use guarantee is structural (the read-and-delete is one Redis
operation), not merely policy — there is no window, even within the TTL,
where the same token could be consumed twice.

## 4. Verification performed in this session

- `npx tsc --noEmit` → 0 errors, at every intermediate step.
- `test/pairing/*` → **32/32 tests passed** (23 state machine incl. new
  Cases 1–4, 5 invitation, 4 registration token — final counts after all
  changes).
- Full backend suite → **80/80 passed**, including the DI-graph smoke
  test confirming `InvitationService`/`RegistrationTokenService` wire
  into `PairingModule`/`AppModule` cleanly.

## 5. Explicitly not built yet

- Domain Services 4 & 5 (Trust Evaluation, Risk Evaluation) — next.
- Controllers (Step 2.2.3).
- The generic `AuditLog` table remains unused — `DevicePairingEvent` is
  its own, separate, already-functioning audit trail for pairing
  specifically; this is not the same gap noted for other modules earlier
  in the project.
