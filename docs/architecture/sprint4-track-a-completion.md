# Sprint 4 — Track A: Complete (Backend + AI Diagnostics + Dashboard)

**Status:** Implemented and fully verified — every item in this document
has a passing `tsc`/test/build result attached, not an assumption.

---

## 1. A real security gap, found and fixed before building on top of it

While wiring AI Diagnostics (which needed the same "does this device
belong to this family" check), I found that `GET /pairing/device/:deviceId/status`
only required `JwtAuthGuard` — **any authenticated parent could query
any device's status, trust level, and risk level by ID, regardless of
which family it belonged to.** Fixed directly:

- `PairingOrchestratorService.getStatus` now requires `familyId` and
  routes through the same `getDeviceOrThrowScopedToFamily` check
  `activate`/`reject`/`revoke` already used — 404, not 403, on mismatch
  (same "don't reveal a device exists in another family" principle as
  `ChildNotFoundException`).
- Added `assertDeviceBelongsToFamily(deviceId, familyId)` — a small,
  reusable public method so other modules (AI Diagnostics, below) don't
  duplicate this check.
- New test: `'SECURITY: throws NotFoundException (not the status) when
  the device belongs to a different family'` — this exact scenario is
  now permanently covered, not just fixed once.

## 2. AI Diagnostics — a genuinely different failure contract, and why

`AiDiagnosticsService` (new, `ai-core` module) composes the existing
`TRUST_SIGNAL_PROVIDER`/`RISK_SIGNAL_PROVIDER` tokens (Sprint 2's
dependency-inversion investment paying off exactly as designed — no
Pairing internals imported, just the interface tokens) with the AI
provider to produce a plain-language device health summary.

**Deliberately not part of `AiCoreOrchestratorService`:** that service
throws `AiCoreUnavailableException` on any AI failure — correct for the
Parenting Assistant, where the AI answer *is* the whole point. Here, the
real trust/risk data is the primary value and is *always* returned; the
summary is strictly additive. `AiDiagnosticsService` degrades to a
fallback sentence on AI failure rather than failing the whole call —
tested explicitly (`'DISTINCT FAILURE CONTRACT'`), including the case
where the AI returns an empty/whitespace-only response.

**Module graph:** `AiCoreModule` now imports `PairingModule` — a
new, one-way dependency. Confirmed non-circular by the DI-graph smoke
test (which would fail at bootstrap if it were): `PairingModule` does
not import `AiCoreModule` or `AiAssistantModule` anywhere.

New endpoint: `GET /ai-core/device-health/:deviceId` (parent-authenticated,
family-ownership-checked via the fix in §1).

## 3. Dashboard — the two real UI gaps this closed

1. **Device Status** (`DeviceStatusCard`) — the Dashboard previously had
   *no* way to see a paired device's trust/risk/capability state at all,
   despite the backend having tracked this since Sprint 2. Now lists
   every device per family (`GET /pairing/devices`), with an on-demand
   "AI Diagnosis" button (calls §2's endpoint once per device per
   session — deliberately not auto-fetched for every device on page
   load, to avoid an LLM call per device on every dashboard visit).
2. **Screen Time Policy** (`ScreenTimePolicyCard`) — `ScreenTimeService`
   has existed since Phase 1 with a working `POST /children/:id/screen-time-policy`
   endpoint, but **no Dashboard UI ever called it** — parents had no way
   to actually set a policy through the product. Closed now: a per-child
   inline form (daily limit, bedtime window, Focus Mode toggle), reusing
   the existing `Input`/`Button`/`Card` components and the same
   `useQuery`/`useState` pattern every other Dashboard feature already
   uses (no new UI conventions introduced).

## 4. Verification performed in this session

- **Backend:** `npx tsc --noEmit` → 0 errors. Full suite (`test/auth`,
  `test/children`, `test/screen-time`, `test/ai-assistant`,
  `test/ai-core`, `test/compliance`, `test/pairing`, `test/common`,
  `test/app.module.spec.ts`) → **138/138 passed** (was 131; +7: the
  security-fix test, 2 `assertDeviceBelongsToFamily` tests, 4
  `AiDiagnosticsService` tests). DI-graph smoke test passed, confirming
  `AiCoreModule -> PairingModule` introduces no circular import.
- **Dashboard:** `npx tsc --noEmit` → 0 errors. `npx vitest run` →
  **14/14 passed** (unchanged — no new component tests added, matching
  this project's existing coverage philosophy of unit-testing
  utils/state, not every React component, same as `ChildrenListCard`/
  `PairingCard` before it). `npx vite build` → succeeds, 117 modules,
  230KB bundle (73.5KB gzip).

## 5. What Track A does NOT include (Track B, by the reviewer's own split)

AccessibilityService, Foreground Service, Boot Receiver, Overlay
Manager, real App Blocking/Enforcement — unchanged from the previous
session's flag. `PermissionManager.kt`/`DeviceCapabilityEngine.kt`
(written previous session, still unverified — no compiler in this
sandbox) are real infrastructure Track B builds on directly.

**Exit criteria noted for Track B, as requested:** AccessibilityService
must be tested on at least 3 real devices from different manufacturers
(e.g. Samsung, Xiaomi, Google Pixel) before Sprint 4 is considered fully
closed — manufacturer-specific Accessibility behavior differences are a
known, real risk category, not a formality.
