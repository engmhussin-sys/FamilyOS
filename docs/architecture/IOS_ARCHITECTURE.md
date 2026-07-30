# iOS Architecture (FamilyOS)

**Status:** Architecture direction adopted. **No iOS code exists yet** —
this document establishes what an iOS Child Agent would be built on,
honestly scoped against real, public Apple frameworks only, per the
explicit "no jailbreak, no private APIs, no claiming permissions that
don't exist" constraint.

## Why iOS is architecturally different from Android, not just "a second platform"

The Android Child Agent (Sprints 3–7) uses `AccessibilityService` +
overlay windows — a real-time, event-driven enforcement model this
project's own ADRs already documented as "instant-close-loop, not true
block" (a real, named limitation). **iOS has no equivalent API family
at all.** Apple's actual parental-control surface (`FamilyControls` +
`ManagedSettings` + `DeviceActivity`) is a fundamentally different
architecture: **declarative, not event-driven** — the app describes a
policy (which apps to shield, when), and the OS enforces it in a
separate, sandboxed system process the app itself never touches at
runtime. This isn't a smaller version of the Android model; it's a
different model that happens to solve a similar problem, and the Child
Runtime Engine's own architecture (`RuntimeCoordinator`, the
enforcement services) would need an iOS-specific implementation of the
same ports, not a port of the Android implementation.

## The real frameworks, honestly scoped

| Framework | What it actually does | What this means for FamilyOS |
|---|---|---|
| **FamilyControls** | Grants an app (with explicit parent consent via `AuthorizationCenter`) the ability to select which apps/categories to manage. Requires Apple's Family Sharing to already be set up device-side. | The permission-request flow is fundamentally different from Android's Accessibility Settings deep-link — it's an Apple-native consent sheet, not something FamilyOS's UI controls. |
| **ManagedSettings** | Declaratively shields selected apps (blocks launch, shows a system-provided "time limit reached" screen) once `DeviceActivity` reports a threshold crossed. | This IS the enforcement mechanism — but it's the OS enforcing a policy FamilyOS *configured*, not FamilyOS enforcing anything itself at runtime. No overlay window equivalent is needed OR possible. |
| **DeviceActivity** | Reports usage duration per app/category on a schedule the OS controls (not real-time), and can trigger a `DeviceActivityMonitor` extension when a threshold is crossed. | Screen-time reporting to FamilyOS's backend would be near-real-time at best, not the ~immediate heartbeat cadence Android's `HeartbeatService` achieves — an honest, real latency difference to design the Parent Dashboard's expectations around. |
| **APNs** | Standard push notification delivery. | Already architecturally compatible — `NotificationsModule` (Sprint 8) is provider-agnostic at the data layer; APNs would be a delivery adapter for existing `Notification` rows, not a new module. |
| **Apple Business Manager (ABM)** | Enterprise device enrollment/management portal for Company/Bank-edition managed devices. | Relevant to the **Enterprise/MDM** document, not the Family/Child Agent flow — a Company deploying FamilyOS to employee-owned-but-managed iPhones would provision through ABM, not through FamilyOS's own pairing flow. |
| **Apple School Manager (ASM)** | ABM's education-sector equivalent — bulk device/app assignment for schools. | Same relationship to the **School edition** that ABM has to Company/Bank. |

## What this explicitly does NOT claim

- **No MDM-level control without ABM/ASM enrollment.** A Family-edition
  iPhone (a personally-owned device, not enterved through ABM) can ONLY
  use `FamilyControls`/`ManagedSettings`/`DeviceActivity` — the same
  consent-gated, declarative model every consumer parental-control app
  on iOS uses. There is no "AccessibilityService-equivalent" backdoor.
- **No always-on real-time enforcement.** `DeviceActivity`'s reporting
  cadence is OS-controlled, not app-controlled — Android's ~30-second
  heartbeat has no iOS equivalent for personally-owned devices.
- **No app removal/installation control** outside of ABM/ASM-managed
  (Company/School/Bank edition) devices.

## Capability Matrix: Android vs. iOS (Family Edition)

| Capability | Android (built, Sprints 3–7) | iOS (architecture only) |
|---|---|---|
| Screen time enforcement | `AccessibilityService` + overlay, real-time | `ManagedSettings` + `DeviceActivity`, OS-scheduled |
| App blocking | Overlay-based (Decision: "instant-close-loop") | `ManagedSettings` shield, OS-native |
| Usage reporting cadence | ~30s heartbeat | OS-scheduled (not app-controlled) |
| Permission grant flow | Settings deep-link (`PermissionStatusService`) | `AuthorizationCenter` consent sheet |
| Background persistence | Foreground Service + WorkManager watchdog (Sprint 6) | No app-level background enforcement needed — `ManagedSettings` runs in a system process independent of the FamilyOS app's own lifecycle |
| Bypass resistance | Documented as limited (no Device Owner) | Stronger for Family edition (OS-enforced, not app-enforced) *once implemented* |

## What a future "build the iOS Child Agent" sprint would need to scope

- A native Swift extension target (`DeviceActivityMonitor`) — the
  iOS equivalent of the Android Foreground Service, architecturally
  required by Apple's design (the monitoring extension runs
  independently of the main app process).
- `RuntimeCoordinator`'s existing port interfaces
  (`ICapabilityProvider`, `IPolicyProvider`) would gain an iOS
  implementation — the Dart-side ports designed in Sprint 3 were
  already written platform-agnostically for exactly this reason.
- The backend's `Device.platform` enum already includes the values
  needed to distinguish iOS from Android devices — no backend schema
  change required for iOS support at the data layer.
