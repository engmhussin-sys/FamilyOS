# ADR — Secure Pairing: Backend Domain Architecture (Step 2.1)

**Status:** Proposed — architecture only, no implementation code, per
explicit instruction. Gates Step 2.2 (implementation) and all Flutter
pairing UI (Parent App and Child Agent screens).
**Builds on:** `pairing-state-machine.md`, `trust-levels-framework.md`,
`risk-score-framework.md`, `pairing-recovery.md`,
`schema-change-proposal-pairing.md`.

---

## 1. Domain Entities

Five entities, three genuinely new, two extending what already exists.
Naming and location follow this project's established clean-architecture
convention (`domain/` types, not ORM models — the Prisma shape is a
separate, later concern per Step 2.2).

### 1.1 `PairingInvitation` (new — ephemeral, Redis-backed, not Postgres)

Unchanged in nature from the existing `PairingService.initiate` design
(one-time, TTL-bound, stored in Redis) — this is a formalization of that
existing entity's shape, not a new mechanism:

```
PairingInvitation {
  code: string              // the human-facing pairing code
  familyId: string
  childId: string
  initiatedByUserId: string
  createdAt: DateTime
  expiresAt: DateTime        // createdAt + 10 minutes, unchanged
  consumed: boolean           // set true atomically on redemption (existing getAndDelete pattern)
}
```

### 1.2 `Device` (existing — extended per `schema-change-proposal-pairing.md`)

No new entity; five new fields per CR-1/CR-3/CR-4/CR-5 (`publicKey`,
`attestationChain`, `trustLevel`, `pairingProtocolVersion`,
`deviceFingerprint`), all already specified there. Not repeated here.

### 1.3 `DevicePairingEvent` (new — per CR-2, append-only)

The audit/state-transition ledger — see §5 for its exact event taxonomy.
Shape unchanged from CR-2's original specification:
`{ deviceId, eventType, fromState, toState, actorType, actorId, occurredAt, metadata }`.

### 1.4 `DeviceRiskAssessment` (new — per CR-3, append-only)

Unchanged from `risk-score-framework.md` §7's final shape:
`{ deviceId, overallRisk, overallLevel, categoryScores, reasons, assessedAt }`.

### 1.5 `PairingSession` (new — the missing piece, proposed here)

**Gap identified:** none of the four entities above track "where is this
specific pairing attempt right now, end to end" as a single addressable
thing a client can poll or resume against
(`pairing-recovery.md`'s "resume from last confirmed state" needs
something concrete to resume *from*). `DevicePairingEvent` is a ledger of
individual transitions, not a single current-state handle. Proposing a
lightweight session concept — **not a new Postgres table**, but a derived
read: "the most recent `DevicePairingEvent` row for a given `deviceId`,
plus the still-valid `PairingInvitation` if one exists in Redis." This
avoids a sixth piece of storage duplicating state that's already fully
derivable from CR-2's table, while still giving Step 2.2 a concrete
query shape (`GET` a device's current pairing status) to implement
against.

## 2. State Transitions → API Endpoint Mapping

The requested six endpoints, mapped against `pairing-state-machine.md`
§4's full transition table. **Two gaps identified and resolved below**,
since the six requested endpoints don't 1:1 cover every state in that
table.

| Endpoint | Actor | Transitions triggered |
|---|---|---|
| `POST /pairing/invite` | `USER` (parent) | — → `INVITATION_CREATED` → `INVITATION_SENT` (combined; delivery is synchronous — the code/QR/link is returned in the same response, not sent asynchronously) |
| `POST /pairing/accept` | `DEVICE` (child, pre-auth) | `INVITATION_SENT` → `INVITATION_OPENED` → `AUTHENTICATING`. Returns a short-lived registration token (not yet a full DEVICE-actor session) — see §4.2 |
| `POST /pairing/device/register` | `DEVICE` (using the registration token from `accept`) | `AUTHENTICATING` → `DEVICE_REGISTERED`. Submits the device's public key (§1.2/CR-1). Returns the real DEVICE-actor token pair (`TokenService`, unchanged) |
| `POST /pairing/verify` | `DEVICE` | `DEVICE_REGISTERED` → `DEVICE_VERIFIED` → `CAPABILITIES_UPLOADED`. **Resolved gap:** capability upload has no dedicated endpoint in the requested six, and the full Capability Engine (Step 4) doesn't exist yet. Proposal: this call carries the Key Attestation chain (or none — §3 of Trust Levels doc) **and** a *minimal* capability payload (manufacturer, model, `SDK_INT` only — trivially available, no dependency on Step 4's full engine). The full/rich `CapabilityProfile` sync happens later via a Step-4-owned endpoint, replacing this minimal snapshot. Also triggers Risk Score's first assessment (`risk-score-framework.md` §8, trigger 1) |
| `POST /pairing/activate` | `USER` (parent) | `CAPABILITIES_UPLOADED` → `PARENT_CONFIRMED` → `POLICY_ASSIGNED` → `ACTIVATED`, orchestrated server-side as one call — these three are sequential and automatic once the parent's explicit confirmation is given, so one parent-facing action drives all three, matching `risk-score-framework.md` §4's response-tier gating (a `HIGH`/`CRITICAL`-risk device requires the *separate* explicit override confirmation described there — modeled as a required `overrideRiskWarning: boolean` field on this same endpoint, not a seventh endpoint) |
| `POST /pairing/revoke` | `USER` (parent) | Any of `ACTIVATED`/`HEALTHY`/`DEGRADED`/`SUSPENDED` → `REVOKED` |

**Second resolved gap — not in the requested six, proposed as additions:**

| Endpoint (proposed addition) | Actor | Transitions triggered |
|---|---|---|
| `POST /pairing/reject` | `USER` (parent) | `CAPABILITIES_UPLOADED` → *(terminal failure)*, the `ParentRejected` path (`pairing-state-machine.md` §4/§6) — without this, a parent has no way to explicitly decline a pairing attempt they don't recognize, which `pairing-recovery.md`'s matrix explicitly requires as a distinct, non-auto-recoverable case |
| `GET /pairing/device/:deviceId/status` | `USER` or `DEVICE` (self) | No transition — read-only, serves §1.5's `PairingSession` concept for `pairing-recovery.md`'s resume logic |

`SUSPENDED`/`REMOVED` transitions (Lost Device, Device Replacement,
removal) are intentionally **not** part of this endpoint set — per
`pairing-state-machine.md` §7, those are their own flows layered on top
of an already-`ACTIVATED` device, out of Step 2.1's scope (pairing
itself), consistent with how `pairing-recovery.md` also excluded them.

## 3. API Contract

All endpoints under `/api/v1` (existing prefix, unchanged). Request/response
shapes below are the field-level contract; exact DTO class names are a
Step 2.2 implementation detail.

### `POST /pairing/invite`
- Auth: `JwtAuthGuard` (`USER`)
- Request: `{ childId: string }`
- Response: `{ code: string, expiresInSeconds: number }` — **unchanged
  from the existing `PairingService.initiate` response shape**; this
  endpoint supersedes `/auth/devices/pairing/initiate` in name/location
  only, not contract (see §6, Migration Note)
- Errors: `404` (child not in caller's family, existing `ChildNotFoundException`),
  `429` (rate limit — see §4.1)

### `POST /pairing/accept`
- Auth: none (the code itself is the credential, same trust model as
  today's `/auth/devices/pairing/confirm`)
- Request: `{ code: string }`
- Response: `{ registrationToken: string, expiresInSeconds: number }` —
  a new, short-lived (5 min, per `pairing-state-machine.md` §7's
  mid-flow timeout), single-purpose token distinct from a real DEVICE
  access token — it can only be used against `device/register`, nothing else
- Errors: `401` (invalid/expired/already-used code — same message for
  all three per `pairing-state-machine.md`'s "don't leak which reason"
  principle, consistent with the login-endpoint precedent in `auth-module.md`)

### `POST /pairing/device/register`
- Auth: `Bearer <registrationToken>` (new, narrow-purpose guard — not
  `JwtAuthGuard`, not `DeviceJwtAuthGuard`; a third, deliberately
  minimal guard whose only job is validating this one-purpose token)
- Request: `{ publicKey: string, platform: 'ANDROID' | 'IOS', deviceModel?: string, osVersion?: string, appVersion?: string, pairingProtocolVersion: string }`
- Response: `ITokenPair` (existing shape, `TokenService`, actorType `DEVICE`)
- Errors: `401` (registration token expired/invalid), `400` (malformed public key)

### `POST /pairing/verify`
- Auth: `DeviceJwtAuthGuard`
- Request: `{ attestationChain?: string, manufacturer: string, model: string, sdkInt: number }`
- Response: `{ trustLevel: TrustLevel, riskAssessment: { overallLevel: RiskLevel, overallRisk: number, reasons: string[] } }` — Explainability (Decision-047) is not optional even at this early stage, per `risk-score-framework.md` §6's binding rule
- Errors: `400` (SDK level below `minSdkVersion` 26 — maps to `pairing-recovery.md`'s "Device unsupported" row, terminal, not retryable)

### `POST /pairing/activate`
- Auth: `JwtAuthGuard` (`USER`)
- Request: `{ deviceId: string, overrideRiskWarning?: boolean }`
- Response: `{ status: 'ACTIVATED', policyAssignedAt: DateTime }`
- Errors: `409` (risk level is `HIGH`/`CRITICAL` and `overrideRiskWarning` was not `true` — the explicit friction step from `risk-score-framework.md` §4), `404` (device not found / not in caller's family)

### `POST /pairing/reject`
- Auth: `JwtAuthGuard` (`USER`)
- Request: `{ deviceId: string, reason?: string }`
- Response: `204 No Content`
- Note: terminal — no `Auto Recovery`, per `pairing-recovery.md`'s explicit rule against silently reversing an explicit rejection

### `POST /pairing/revoke`
- Auth: `JwtAuthGuard` (`USER`)
- Request: `{ deviceId: string, reason?: string }`
- Response: `204 No Content`
- Side effect: all of that device's refresh tokens are revoked
  (extends the existing `RefreshTokenRepository.revokeAllForUser`-equivalent
  to a device-scoped variant — flagged as a required delta in
  `pairing-state-machine.md` §7, implemented here)

### `GET /pairing/device/:deviceId/status`
- Auth: `JwtAuthGuard` (`USER`) or `DeviceJwtAuthGuard` (self only —
  a device may query its own status, never another device's)
- Response: `{ currentState: PairingState, lastEventAt: DateTime, invitationStillValid: boolean }`

## 4. Security Considerations

### 4.1 Rate limiting
- `pairing/invite`: existing global Throttler (5/min pattern, matching
  `auth.controller.ts`'s register/login precedent) **plus** the
  per-family limit flagged as a delta in `schema-change-proposal-pairing.md`
  §7 — implemented here as a Redis-backed counter keyed on `familyId`,
  not IP (an IP-based limit alone doesn't stop one family generating
  excessive invitations from different networks).
- `pairing/accept`: unchanged from the existing `/auth/devices/pairing/confirm`
  precedent (10/min).
- `pairing/verify`, `pairing/activate`: standard app-default throttle —
  these require an already-authenticated actor, meaningfully reducing
  abuse surface compared to the pre-auth endpoints above.

### 4.2 Registration token — a deliberate third token type
`accept`'s `registrationToken` is neither a USER access token nor a
DEVICE access token — it exists specifically so a partially-authenticated
device (has redeemed a code, has not yet registered a keypair) cannot
call any other protected endpoint. This closes a gap the original
two-endpoint pairing design didn't need to consider: with only
`initiate`/`confirm`, there was no intermediate state to protect. The
richer state machine introduces one, so the token model grows to match —
not because more tokens are inherently better, but because this
specific intermediate state now exists and needs its own boundary.

### 4.3 Replay protection (closing `schema-change-proposal-pairing.md`'s
flagged delta)
`accept`'s response token is bound to the specific `PairingInvitation`'s
one-time-use flag at the Redis layer — consuming the invitation (existing
`getAndDelete`) and issuing the `registrationToken` happen atomically, so
a captured-and-replayed `accept` request fails the same way a replayed
code does today (the invitation is already gone), closing the "nonce-bound
authentication-request replay protection" gap from `pairing-state-machine.md`
§7 without needing a separate nonce mechanism — the existing one-time-use
guarantee, applied one step further into the flow, is sufficient.

### 4.4 Ownership enforcement (unchanged pattern)
Every endpoint that accepts a `childId` or `deviceId` resolves ownership
via the existing `ChildrenService.assertChildBelongsToFamily` /
equivalent family-scoped device lookup — no new pattern, the established
one from `children-module.md` §2 applies unchanged.

### 4.5 Risk-gated activation (implements `risk-score-framework.md` §4 concretely)
`activate`'s `409` + `overrideRiskWarning` requirement is the literal
mechanism behind that document's "does not auto-activate" rule for
`HIGH`/`CRITICAL` risk — this is the first place that rule becomes an
actual enforced API behavior rather than a stated principle.

## 5. Audit Events Mapping

Adopting the reviewer's `PAIRING_*`/`DEVICE_*` `SCREAMING_SNAKE_CASE`
naming as the canonical event-type style going forward (supersedes
`pairing-state-machine.md` §5's originally-proposed `PascalCase` list —
noted here as the naming authority for `docs/specifications/enumerations.md`'s
next update, not applied to that file in this step per the "no other
file modified" constraint on this response).

| Endpoint | `DevicePairingEvent.eventType` |
|---|---|
| `pairing/invite` | `PAIRING_INVITATION_CREATED` |
| `pairing/accept` | `PAIRING_ACCEPTED` |
| `pairing/device/register` | `DEVICE_REGISTERED` |
| `pairing/verify` (success) | `DEVICE_VERIFIED`, then `CAPABILITIES_UPLOADED` (two events — this call triggers two transitions per §2, so it writes two ledger rows, in order) |
| `pairing/verify` (unsupported device) | `DEVICE_VERIFICATION_FAILED` |
| `pairing/activate` (success) | `PARENT_CONFIRMED`, `POLICY_ASSIGNED`, `DEVICE_ACTIVATED` (three events, same reasoning as above) |
| `pairing/activate` (blocked, risk override needed) | `ACTIVATION_BLOCKED_HIGH_RISK` |
| `pairing/reject` | `PAIRING_REJECTED` |
| `pairing/revoke` | `DEVICE_REVOKED` |

Every row is written by the same `AuditLog`-adjacent writer flagged as
required in `pairing-state-machine.md` §5 — this is that writer's first
concrete consumer and complete event list for the pairing domain
specifically (Screen Time, Location, etc. will define their own event
lists when their turn comes, following this same pattern, not sharing
this exact list).

## 6. Migration note — relationship to the existing Auth module endpoints

`apps/backend/src/modules/auth/presentation/controllers/device-pairing.controller.ts`
(built in an earlier step) already implements a simpler two-endpoint
version of `invite`/`accept` combined (`/auth/devices/pairing/initiate`
and `/auth/devices/pairing/confirm`). Step 2.2 must decide, as an
explicit implementation-time question, whether to:
(a) evolve those two endpoints in place to match this richer contract, or
(b) build the new `/pairing/*` endpoints as a parallel `PairingModule`
and deprecate the old ones.
**Not resolved in this architecture document** — flagged as the first
question Step 2.2 must answer before writing any code, consistent with
this project's practice of surfacing decisions rather than making them
implicitly mid-implementation.
