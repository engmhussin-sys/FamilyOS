# ADR — Pairing Module Boundary

**Status:** Proposed. Formalizes Decision-052 (standalone PairingModule)
and defines its scope per this step's explicit instruction, before any
Step 2.2 code is written.

---

## 1. Why Pairing ≠ Authentication (Decision-052)

| Question | Owned by |
|---|---|
| Who are you? | **Auth** |
| Is your session valid? | **Auth** |
| Who owns this device? | **Pairing** |
| Is this device trusted? | **Pairing** |
| Has the invitation been accepted? | **Pairing** |
| Has the child been activated? | **Pairing** |
| Has the device been revoked? | **Pairing** |

Auth answers *identity* questions for both `USER` and `DEVICE` actors
generically. Pairing answers *relationship and trust* questions specific
to the parent-child-device triangle. Collapsing them was the original
design's simplification (reasonable at the time — a two-endpoint flow
didn't need the distinction); the full state machine does need it.

## 2. Integration direction (one-way, per Decision-052's diagram)

```
Auth Module
     ↓  (Pairing consumes TokenService to issue DEVICE token pairs
     ↓   at device/register and rotate them going forward — same
     ↓   TokenService, no duplicate token-issuance logic)
Pairing Module
     ↓  (Device-management concerns — health score queries, device
     ↓   listing for a parent, future device-replacement UX — build
     ↓   on top of Pairing's completed state, not the reverse)
Device Module (future, not built yet)
```

**Binding rule:** Auth never imports Pairing. Pairing never imports
anything that would create a cycle back into Auth's controllers/DTOs —
only `TokenService` (already exported from `AuthModule`, unchanged).
`ChildrenModule` is imported by Pairing the same way it's imported by
`ScreenTimeModule`/`ComplianceModule`/`AiAssistantModule` today — the
established, unchanged ownership-check pattern.

## 3. What's inside `PairingModule`

✅ `PairingInvitation` (Redis-backed) creation/redemption
✅ `PairingSession` derived-state reads (§1.5 of the Step 2.1 doc)
✅ The full pairing state machine's transition logic
✅ Registration Token, and DEVICE token issuance *at the point of
   registration* (calling into `AuthModule`'s `TokenService`, not
   reimplementing it)
✅ Activation workflow (`PARENT_CONFIRMED` → `POLICY_ASSIGNED` → `ACTIVATED`)
✅ Revocation
✅ `DevicePairingEvent` audit writes for every transition in this module's
   scope

## 4. What's explicitly OUTSIDE `PairingModule`

❌ **Authentication** — login/refresh/logout for `USER` actors stay in
`AuthModule`, unchanged. Pairing does not gain a parallel login mechanism.
❌ **Screen Time** — policy assignment at `POLICY_ASSIGNED` calls into
`ScreenTimeModule`'s existing `ScreenTimeService` (or a documented default
if none exists yet) — Pairing triggers it, does not own policy logic itself.
❌ **Location** — not referenced by Pairing at all currently.
❌ **Policy Enforcement** — belongs to the Child Agent's own Policy Engine
(Step 8) and `ScreenTimeModule`; Pairing's job ends at "policy was
successfully assigned," not enforcing it.
❌ **AI** — `AiAssistantModule` is untouched by this work.
❌ **Notifications Engine** — doesn't exist yet (flagged in
`pairing-state-machine.md` §7's Lost Device flow as a future need);
Pairing emits audit events that a *future* notification consumer would
subscribe to — Pairing does not send notifications itself.

**Enforcement of this boundary going forward:** any PR adding a
capability to `PairingModule` that isn't in §3's list, or that requires
importing a module not named in §2, should be treated as a boundary
violation requiring its own architecture review — the same discipline
already applied to the Child Agent's plugin boundaries
(`child-agent-plugin-architecture.md` §2's "a plugin never imports
another plugin directly" rule, applied here to backend modules instead).

## 5. Legacy endpoint disposition (Decision-053)

`/auth/devices/pairing/initiate` and `/auth/devices/pairing/confirm`
(existing, `AuthModule`) are **not removed**. Marked `Deprecated`
(documentation + response header, per Step 2.2's implementation),
internally delegating to the new `PairingModule`'s equivalent logic via
a thin adapter — existing clients calling the old paths keep working
identically; nothing new is built on top of the old paths going forward.
Removal is a future version's decision, not this one's.
