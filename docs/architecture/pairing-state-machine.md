# ADR — Pairing State Machine

**Status:** Proposed — gates all Secure Pairing (Step 2) implementation
and UI, per explicit instruction. Covers Decisions 021–030.
**No code in this document**, per the same instruction.

---

## 0. The scale question, applied

Per the standing directive — *"would this design still hold at 10 million
users?"* — three consequences shape this document specifically:

1. **State is never overwritten in place.** Every transition below is
   both a state change AND an appended, immutable event row (§5). At
   scale, "what happened to this device" is an investigation/support
   query that must not depend on data that was already overwritten.
2. **Invitations must be cheap to issue and expire aggressively.** A
   10M-family platform issuing pairing invitations needs them
   short-lived, indexed, and never requiring a full-table scan to
   validate — this is why they live in Redis (already true of the
   current pairing-code implementation), not Postgres.
3. **Trust Score and Health Score are computed, not stored as a single
   mutable number updated by many writers.** Both are derived from the
   append-only event/heartbeat history (§8, §9) — recomputable, auditable,
   and safe under concurrent writes from many devices, rather than a
   single row every heartbeat contends to update.

---

## 1. Trust Model (Decision-021)

**Device Identity, realistically, on Android:**

| Decision-021 term | Realistic Android mechanism |
|---|---|
| Device Certificate | **Not** a CA-issued X.509 cert (unnecessary PKI overhead for this use case). Instead: an asymmetric keypair generated **inside Android Keystore** at Device Registration (Step 3), hardware-backed (TEE/StrongBox) on supporting devices. |
| Public Key | The public half of that keypair, registered with the backend at Device Registration. The private key **never leaves the device's secure hardware** — it can sign, it cannot be exported, even by the app itself. |
| "Trust" evidence | Android's **Key Attestation** extension: when available, the Keystore can produce a certificate chain rooted in a Google-controlled root key, cryptographically proving the keypair really was generated in secure hardware (not software-emulated). **Available on most real, Google-certified devices from the last several years; not guaranteed on older devices, some budget OEM builds, or emulators.** |
| Secure Token | The existing DEVICE-actor refresh/access token pair (`TokenService`, already built) — unchanged by this ADR. |
| Trust Score | See formula below — **not** a boolean "attested or not." |

**Trust Score (0–100), computed, not stored as a single writable field:**

| Signal | Weight | Rationale |
|---|---|---|
| Key Attestation chain present & valid | +30 | Strongest available signal; absence is not disqualifying (older devices) |
| No open `TamperSignal`s (from `IAntiTamper`, once Step 9 exists) | +25 | |
| Consistent heartbeat history (no unexplained multi-day gaps) | +20 | |
| Capability profile internally consistent (e.g. claimed API level matches observed behavior) | +15 | |
| Time since pairing (new devices start lower, rises over the first week) | +10 | Guards against a freshly-paired device being immediately over-trusted |

A device that fails attestation (no hardware support) is **not blocked**
— excluding older/non-Google-certified devices would exclude real
families, contradicting this project's own accessibility goals. It
simply starts and stays capped at a lower maximum achievable score,
which downstream policy (future decision) MAY use to require additional
parent confirmation for higher-risk actions on low-trust devices.

## 2. Roles note (Decision-025) — scoped to what Pairing needs to know

Full RBAC redesign is out of scope for this document. What Pairing
specifically needs: **who is allowed to approve a pairing (§4, Parent
Confirmation state)?** Proposal: any active `FamilyMember` regardless of
role (`OWNER` or `PARENT`) can approve — restricting approval to `OWNER`
only would block a genuine second parent from pairing a device while the
account owner is unavailable, which defeats the purpose of Decision-025.
**Schema delta required** (not implemented here): the current
`FamilyRole` enum (`OWNER | PARENT`) does not yet model grandparent/
guardian distinctions — noted as a required follow-up decision, not
assumed solved by this document.

## 3. Multi-Child (Decision-024) — already satisfied, no change needed

The schema has supported `Family 1───* Child` since the first database
step; nothing about this state machine assumes a single child. Listed
here only to confirm it explicitly, per the request.

---

## 4. Pairing State Machine

**Canonical state list** (reconciling Decision-022's and Decision-023's
slightly different phrasings into one list — "Parent Approved" and
"Parent Confirmation" are the same state, standardized here as
`PARENT_CONFIRMED`):

```
INVITATION_CREATED
      ↓
INVITATION_SENT
      ↓
INVITATION_OPENED          (child device redeemed the code, not yet authenticated)
      ↓
AUTHENTICATING              (Step 2's actual token exchange happens here)
      ↓
DEVICE_REGISTERED           (Device row created, keypair registered — Step 3)
      ↓
DEVICE_VERIFIED              (Key Attestation checked, Trust Score computed)
      ↓
CAPABILITIES_UPLOADED          (Step 4's first Capability Profile received)
      ↓
PARENT_CONFIRMED                 (explicit parent action — §1's role note)
      ↓
POLICY_ASSIGNED                    (initial ScreenTimePolicy/AppBlockRule pushed)
      ↓
ACTIVATED                            (device is now live/enforcing)
      ↓
HEALTHY  ⇄  DEGRADED                  (ongoing operational states, not terminal)
      ↓
SUSPENDED   (parent-initiated OR system-initiated, e.g. Lost Device §7)
      ↓
REVOKED
      ↓
REMOVED                                (terminal — record retained for audit, per §5)
```

**Design rule:** `ACTIVATED` is the LAST step before ongoing operation,
never the first — Decision-023's explicit requirement. A device sitting
in any state before `ACTIVATED` has **zero enforcement authority** and
must not be treated as paired by any other module (Screen Time, Location,
etc.) that checks device status.

### Transition table

| From | Event | To | Guard |
|---|---|---|---|
| — | `CreateInvitation` | `INVITATION_CREATED` | Caller is an active FamilyMember (§2); child belongs to caller's family (existing `ChildrenService.assertChildBelongsToFamily`) |
| `INVITATION_CREATED` | `InvitationDelivered` | `INVITATION_SENT` | — |
| `INVITATION_SENT` | `RedeemAttempted` | `INVITATION_OPENED` | Code not expired, not already used (existing Redis TTL+one-time-use mechanism) |
| `INVITATION_OPENED` | `AuthenticationStarted` | `AUTHENTICATING` | — |
| `AUTHENTICATING` | `AuthenticationSucceeded` | `DEVICE_REGISTERED` | Device public key received and well-formed |
| `AUTHENTICATING` | `AuthenticationFailed` | *(terminal failure — see §6)* | — |
| `DEVICE_REGISTERED` | `AttestationChecked` | `DEVICE_VERIFIED` | Always succeeds (attestation absence lowers Trust Score, per §1, but does not block the transition) |
| `DEVICE_VERIFIED` | `CapabilityProfileReceived` | `CAPABILITIES_UPLOADED` | Profile passes basic sanity validation (e.g. claimed API level is a real Android API level) |
| `CAPABILITIES_UPLOADED` | `ParentApproved` | `PARENT_CONFIRMED` | Explicit action from an authenticated FamilyMember, not automatic |
| `CAPABILITIES_UPLOADED` | `ParentRejected` | *(terminal failure — see §6)* | Parent can reject a pairing they didn't initiate/don't recognize |
| `PARENT_CONFIRMED` | `PolicyPushed` | `POLICY_ASSIGNED` | At least one default policy exists to assign (falls back to a documented default if the family hasn't configured one yet) |
| `POLICY_ASSIGNED` | `EnforcementConfirmed` | `ACTIVATED` | Device acknowledges receipt of the policy (round-trip confirmed, not fire-and-forget) |
| `ACTIVATED` | `HeartbeatReceived` (on schedule) | `HEALTHY` | — |
| `HEALTHY` | `HeartbeatMissed` (threshold exceeded — §7) | `DEGRADED` | — |
| `DEGRADED` | `HeartbeatReceived` | `HEALTHY` | Self-heals automatically — no parent/admin action needed for a transient gap |
| `HEALTHY` \| `DEGRADED` | `ParentSuspended` \| `LostDeviceReported` (§7) \| `TamperCritical` (future, Step 9) | `SUSPENDED` | |
| `SUSPENDED` | `ParentReactivated` | `ACTIVATED` | Only from `SUSPENDED`, never directly from `REVOKED` |
| `SUSPENDED` \| `HEALTHY` \| `DEGRADED` | `ParentRevoked` \| `ReplacementCompleted` (§7) | `REVOKED` | |
| `REVOKED` | `ParentRemoved` | `REMOVED` | Explicit, separate action from revocation — revoking stops trust immediately; removal is tidying up the record afterward, intentionally not the same click |

## 5. Events (Decision-030) — audit trail

Every transition above emits an event with this minimal shape:
`{ eventType, deviceId, childId, familyId, actorType, actorId, occurredAt, metadata }`.

**Schema delta required (not implemented in this document):** the
`AuditLog` table has existed since the first database step but — like
`ParentalConsent` before the Compliance module — **has no writer yet**.
This state machine is the first concrete consumer that actually needs
`AuditLog` to be written to, not just declared in the schema. Implementing
Step 2 must include the `AuditLog` writer as a hard requirement, not an
optional nicety, or Decision-030 is not actually satisfied by "we have a
table for it."

Event type list (matches the transition table 1:1 — no event exists that
isn't a real transition, and no transition happens without its event):
`InvitationCreated, InvitationDelivered, InvitationOpened,
AuthenticationStarted, AuthenticationSucceeded, AuthenticationFailed,
DeviceRegistered, AttestationChecked, CapabilityProfileReceived,
ParentApproved, ParentRejected, PolicyPushed, EnforcementConfirmed,
HeartbeatReceived, HeartbeatMissed, ParentSuspended, LostDeviceReported,
TamperCritical, ParentReactivated, ParentRevoked, ReplacementCompleted,
ParentRemoved`.

## 6. Failure states

Two categories, handled differently:

- **Terminal failures** (`AuthenticationFailed`, `ParentRejected`): the
  invitation/device row is marked failed and retained for audit (§5), but
  does **not** silently retry — the child device must obtain a fresh
  invitation. Silently retrying authentication automatically would blur
  the line with Decision-029's replay-protection requirement.
- **Transient failures** (a step in the sequence between
  `AUTHENTICATING` and `ACTIVATED` times out or the device loses
  connectivity mid-flow): resumable — see §7's retry strategy. The
  device re-attempts from its **last confirmed state**, not from
  `INVITATION_CREATED` again, since the invitation itself was already
  consumed (one-time use).

## 7. Retry, timeout, and recovery strategy

| Concern | Strategy |
|---|---|
| Invitation expiration | 10 minutes (existing value, unchanged — `PAIRING_CODE_TTL_SECONDS` in the current `PairingService`) |
| Invitation use | One-time (existing `getAndDelete`, unchanged) |
| Rate limiting | Existing: 10/min on `pairing/confirm`. Decision-029 additionally requires per-family rate limiting on `pairing/initiate` (not yet built — currently only global-per-IP via the default Throttler; a **schema/logic delta required**: per-family invitation-creation rate limiting) |
| Replay protection | One-time-use codes already prevent literal replay of the same code. **Additional delta required:** each `AuthenticationStarted` should bind to the specific invitation's one-time nonce so a captured-and-replayed authentication request (not just a replayed *code*) is also rejected — not yet explicit in the current implementation |
| Mid-flow timeout (`AUTHENTICATING` → `CAPABILITIES_UPLOADED`) | 5 minutes from `INVITATION_OPENED` — if `PARENT_CONFIRMED` isn't reached within this window, the attempt is marked a transient failure and the device must re-open (not re-request) the same still-valid invitation if it hasn't separately expired |
| `PARENT_CONFIRMED` wait | No hard timeout — a parent may take longer than 5 minutes to tap "approve" on their own device. State sits at `CAPABILITIES_UPLOADED` indefinitely until the *invitation's own* 10-minute TTL or an explicit parent rejection |
| Heartbeat miss threshold (`HEALTHY` → `DEGRADED`) | 2 consecutive missed heartbeats (interval TBD by Step 7/Decision-009's transport, not fixed here) |
| `DEGRADED` → `SUSPENDED` auto-escalation | NOT automatic in this design — degraded devices self-heal (§4) or require explicit parent/Lost-Device action; auto-suspending on a connectivity gap would create false-positive suspensions for a child who was simply on a plane |
| Recovery: Device Replacement (Decision-026) | `SUSPENDED`/`ACTIVATED` old device → `ReplacementCompleted` event → old device transitions to `REVOKED`, and a **new** pairing flow starts fresh from `INVITATION_CREATED` for the new device, with policy copied (not re-configured from scratch) from the old device's last `POLICY_ASSIGNED` state — this copy step is new logic, not automatic from the state machine alone |
| Recovery: Lost Device (Decision-027) | `LostDeviceReported` (parent-initiated) → `SUSPENDED` → refresh tokens revoked immediately (existing `RefreshTokenRepository.revokeAllForUser`-equivalent, needs a device-scoped variant — **delta required**) → policies frozen (last-known state retained, not deleted) → parent may then initiate Device Replacement above for a new device |

## 8. Device Health Score (Decision-028)

Distinct from Trust Score (§1, which is about *identity* confidence) —
Health Score is about *current operational* confidence:

| Signal | Contribution |
|---|---|
| Time since last successful heartbeat | Heaviest weight — a stale device is the single strongest "something's wrong" signal |
| Time since last successful policy sync | |
| Current battery level (very low battery correlates with imminent connectivity loss) | |
| Count of currently-unresolved `TamperSignal`s (Step 9) | |
| Policy compliance (is the device actually enforcing what was assigned, per its own self-report) | |
| Crash count in the last 24h | |

Like Trust Score, this is **computed on read** from the event/heartbeat
history, not a single mutable stored field multiple processes race to
update.

## 9. Security checklist against Decision-029 — what's already satisfied vs. still needed

| Requirement | Status |
|---|---|
| Expiration | ✅ Already built (10 min TTL) |
| One-time use | ✅ Already built (`getAndDelete`) |
| Rate limiting | ⚠️ Partial — global/IP-based exists; **per-family limiting on `initiate` is a delta** (§7) |
| Replay protection | ⚠️ Partial — code-level replay prevented; **nonce-bound authentication-request replay protection is a delta** (§7) |
| Audit trail | ❌ Not yet — **AuditLog writer is a hard requirement for Step 2**, not optional (§5) |

## 10. Schema deltas required (design-level list — not implemented in this document)

Explicitly enumerated so Step 2's implementation has a known, upfront
list rather than discovering these mid-build:

1. `Device`: add `publicKey`, `attestationChain` (nullable), computed
   Trust/Health Score are NOT stored columns (§1, §8) but their raw
   inputs (last heartbeat, crash count, etc.) need columns/tables to
   compute from.
2. A richer pairing-state representation than the current 4-value
   `DeviceStatus` enum (`PENDING_PAIRING | ACTIVE | REVOKED | LOST`) —
   either expand the enum to the full state list in §4, or (likely
   better at scale, per §0) a separate append-only
   `DevicePairingEvent` table that the current `status` field is
   *derived* from, keeping `Device.status` as a fast-read summary.
3. An `AuditLog` writer wired into the pairing flow specifically (the
   table exists; nothing writes to it yet — same gap `ParentalConsent`
   had before the Compliance module, now recurring here).
4. `FamilyRole` enum expansion for Decision-025's guardian types — a
   separate decision, flagged, not resolved here.
5. Per-family (not just per-IP) rate limiting on `pairing/initiate`.
6. A `PolicyCopy` capability for Device Replacement (§7) — copying the
   old device's last assigned policy to the new device's initial
   `POLICY_ASSIGNED` transition, rather than requiring the parent to
   reconfigure from scratch.

None of these are implemented by this document — this is the explicit,
upfront list Step 2 must account for, consistent with this project's
practice of surfacing required-but-not-yet-built work rather than
discovering it mid-implementation.
