# Sprint 3 (Flutter Half) — Child Agent Foundation: Device Registration + Heartbeat

**Status:** Written, manually reviewed (brace/paren balance across all 13
touched files — matched). **Not compiled or run** — this sandbox has no
Flutter SDK access, per the standing disclosure since Step 1. Run
`flutter analyze && flutter test` before treating this as verified.

Closes the half of Sprint 3 flagged as deferred in
`pairing-sprint3-backend-vertical.md` §8.

---

## 1. What was built

| Layer | File(s) | Purpose |
|---|---|---|
| Kotlin (native bridge) | `DeviceIdentityKeyManager.kt` | Generates/retrieves the device's Android Keystore identity keypair |
| Dart platform channel | `agent_channel*.dart` (extended) | `getDevicePublicKey()` added — Step 1's port/impl/constants pattern, not a new mechanism |
| Dart network | `api_client.dart` (extended) | `postWithBearerToken()` — the escape hatch for the one-time Registration Token |
| Dart feature | `features/pairing/` (new) | `PairingApi`, `DeviceRegistrationService`, `HeartbeatService`, `PairingScreen` |
| Dart app shell | `app.dart` (rewired) | Routes to `PairingScreen` (unpaired) or the paired-status screen (paired), starts the heartbeat on either path to pairing |

## 2. Device Identity — Trust Model, implemented for real

`DeviceIdentityKeyManager` generates an EC keypair (`secp256r1`) directly
inside Android Keystore, hardware-backed where the device supports it —
exactly `pairing-state-machine.md` §1's Trust Model, not a placeholder.
The private key never leaves Keystore; only
`getPublicKeyBase64()`'s X.509 SubjectPublicKeyInfo crosses the platform
channel, matching the backend's `publicKey: string` field exactly
(`pairing-backend-domain-architecture.md` §3).

**Honest limitation (mirrors the backend's own §4 disclosure):** Key
Attestation chain retrieval is NOT implemented — only the identity
keypair itself. The backend currently treats any non-empty
`attestationChain` as valid, and this Kotlin layer doesn't send one at
all yet, so real devices pairing today land at Trust Level `L2_VERIFIED`
(no attestation offered), never `L3_ATTESTED`. Both sides of this gap
are now documented in the same place conceptually — closing it requires
Kotlin work (`setAttestationChallenge`) and nothing on the Dart or
backend side.

## 3. `postWithBearerToken` — a third auth mode, not a redesign

`ApiClient` already had two modes: stored-session auth, and `skipAuth`
for pre-auth calls (login/register/refresh). Registration needed a
**third**: send a specific one-time token that is neither the stored
session token nor "no token." Added as one new method reusing the
existing interceptor's `skipAuth` escape hatch internally — the
refresh-and-retry logic is untouched, since a registration-token 401
should never trigger a session refresh attempt (there's no session yet).

## 4. Heartbeat — Dart `Timer`, explicitly not the final mechanism

`HeartbeatService` is a `dart:async` `Timer.periodic` — it only runs
while the Flutter engine is alive. This is **not** the
survives-app-kill, survives-reboot mechanism `child-agent-lifecycle.md`
§2/§5/§6 specifies (native Foreground Service + `WorkManager` watchdog +
`BOOT_COMPLETED` receiver) — that's explicitly Sprint 4's "Android
Native Layer" scope, per the reviewer's own sprint plan. This class
exists so the backend's new `/pairing/device/heartbeat` endpoint has a
real, tested Dart consumer today, and so Sprint 4's native service has
something concrete to eventually trigger (or reimplement natively
calling the same endpoint) — not left sitting unconsumed.

## 5. Verification performed in this session

- Manual brace/paren balance check across all 13 touched files — all
  matched (see the exact command output in this session's transcript).
- Cannot run `flutter analyze` / `flutter test` here (standing
  limitation). Tests were still written, targeting the same rigor as
  every compiled module in this project:
  - `device_registration_service_test.dart` — 3 tests, using the
    established manual-fake pattern (no mockito codegen): verifies the
    exact code/token/publicKey/platform values flow through to the
    right calls, and that the resulting session is actually persisted
    via the real `SecureTokenStorage` (backed by a fake
    `FlutterSecureStorage`, same technique as Step 1's own test).
  - `heartbeat_service_test.dart` — 5 tests: not-running-before-start,
    immediate heartbeat on `start()`, `stop()` cancels, a failed
    heartbeat doesn't throw/stop the service (Decision-011), and
    `start()` called twice doesn't stack timers.

## 6. Explicitly not built (Sprint 4's scope, per the reviewer's own plan)

- AccessibilityService, UsageStatsManager, Foreground Service, Permission
  Manager, Device Capability Engine — all explicitly Sprint 4.
- Key Attestation chain retrieval (§2).
- Real backoff/offline-queue for heartbeat failures (Offline Sync
  Engine, Step 7 in the original 12-step order — not renumbered by the
  new 10-Sprint plan, still not reached).
- `HEARTBEAT_MISSED` detection (needs backend scheduling infra —
  flagged in `pairing-sprint3-backend-vertical.md` §3, unchanged).
