# Mobile Release Checklist

## Android — Verified (code review + static analysis this session; real-device validation still required, see below)

| Area | Status | Evidence |
|---|---|---|
| Pairing flow | ✅ Fixed this Sprint | Dashboard now calls the current `PairingModule` endpoint (previous session's critical fix); `pairing_api.dart`'s `accept()` already targeted the correct endpoint since Sprint 3 |
| Device Registration | ✅ Real | `DeviceRegistrationService`, EC keypair in Android Keystore (`DeviceIdentityKeyManager.kt`) |
| Heartbeat | ✅ Real, with Offline Queue | `HeartbeatService` — failed heartbeats now queue (Sprint 7's `OfflineQueue`) and drain on the next successful heartbeat |
| Local Policy Cache | ✅ Real | `PolicyCacheService`, `NativePolicyStore.kt` (SharedPreferences, independent of Flutter engine lifecycle) |
| Runtime Engine | ✅ Real, documented limitation | `ChildGuardAccessibilityService.kt` + `OverlayManager.kt` — explicitly documented as "instant-close-loop, not true block" (no Device Owner) since the ADR that introduced it |
| Permission Handling | ✅ Real | `PermissionManager.kt` — Accessibility, Overlay, battery-optimization exemption, all check real system state, not just declared manifest permissions |
| Battery Optimization Handling | ✅ Real | `PermissionManager.isBatteryOptimizationExempted()` — confirmed this session to be a real system-state check (`isIgnoringBatteryOptimizations`), not manifest-only |
| Offline Behavior | ✅ Real | `OfflineQueue` (Sprint 7) persists via `flutter_secure_storage`, caps at 200 events, drains oldest-first on reconnect |
| Recovery | ✅ Real | `RecoveryCoordinator` re-syncs policy + restarts enforcement service on app resume if protection looks unhealthy |

**Not yet verified on this checklist: real-device behavior.** Every
item above is a code-level review — none of it has been run on a
physical Samsung/Xiaomi/Pixel device. This remains the standing exit
criterion from Sprint 4/5, unchanged by this session.

## iOS — Architecture only, nothing built

See `docs/architecture/IOS_ARCHITECTURE.md` for the full reasoning.
Summarized here as the capability matrix requested:

| Feature | Status |
|---|---|
| Parent App | Not started — the Admin Dashboard (React/web) is the only parent-facing interface today |
| Child Agent | Not started |
| Pairing | Requires Apple `FamilyControls` `AuthorizationCenter` consent flow — architecturally different from Android's code-based pairing, not a port of it |
| Screen Time Enforcement | Requires `ManagedSettings` + `DeviceActivity` — OS-enforced, declarative, not event-driven like Android's AccessibilityService |
| Push Notifications | Requires APNs integration — `NotificationsModule`'s data layer is already provider-agnostic, no backend redesign needed |
| Enterprise Deployment | Requires Apple Business Manager / Apple School Manager enrollment — see `ENTERPRISE_MDM_ARCHITECTURE.md` |
| Background Enforcement | Limited by design on Family edition (no jailbreak, no private API) — `ManagedSettings` runs OS-side, independent of app lifecycle |

**No iOS code exists. No iOS claims are made anywhere in this release.**

## Real Device Validation — required before v1.0, not performed in this environment

This project has been built entirely in a sandboxed environment with no
physical device access. The following remain **required, unperformed**
exit criteria, unchanged since they were first identified:

- 3-manufacturer Android real-device test (Samsung, Xiaomi, Google
  Pixel) — `AccessibilityService` behavior is known to vary by OEM
  (background-kill aggressiveness, permission-dialog wording).
- Battery drain measurement over a real 24-hour cycle.
- Real network transition testing (WiFi↔cellular, airplane mode) for
  the Offline Queue's drain behavior.
