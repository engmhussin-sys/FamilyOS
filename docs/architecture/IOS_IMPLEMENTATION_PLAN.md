# iOS Implementation Plan

**No Swift code in this document.** This is the approved plan
`IOS_ARCHITECTURE.md` (Sprint 10) pointed toward — turning that
architecture into a concrete, sequenced implementation plan with an
honest feature-parity table, so the team never promises an iOS
capability Apple doesn't allow.

---

## Feature Parity Table

### 100% matched — same user-facing outcome, different underlying mechanism

| Feature | Android mechanism | iOS mechanism |
|---|---|---|
| Pairing a device | `PairingModule` invite code, entered manually | Same invite-code flow — the backend contract is identical (`POST /pairing/invite`, `POST /pairing/accept`) |
| Screen time daily limit | `PolicyEnforcer` + local policy cache | `ManagedSettings` shield rule, configured from the same backend `ScreenTimePolicy` |
| Bedtime schedule | `PolicyEnforcer` time-window check | `DeviceActivity` schedule-based monitoring |
| Push notifications | (planned) FCM | (planned) APNs — `NotificationsModule`'s data layer is provider-agnostic already |
| Runtime status visibility (Parent Dashboard) | `RuntimeTimelineCard`, `DeviceStatusCard` | Identical Dashboard views — no iOS-specific backend/Dashboard work needed |
| Offline policy enforcement | `NativePolicyStore` (SharedPreferences) | `ManagedSettings` — runs OS-side, independent of the app process (a structural iOS advantage) |

### Will differ — real iOS platform constraints, not an implementation shortcut

| Feature | Android behavior | iOS behavior | Why it differs |
|---|---|---|---|
| Usage reporting cadence | ~30s heartbeat | OS-scheduled `DeviceActivity` reports, not app-controlled | Apple does not expose a real-time usage API to third-party apps, by design |
| Enforcement latency | Near-instant, "close-loop not true-block" | Can be genuinely instant AND a true block | iOS's declarative model is enforced by the OS itself, not detected-and-reacted-to |
| Permission grant flow | Settings deep-link, polled status | Apple `AuthorizationCenter` native consent sheet | Different OS-level consent architecture entirely |
| Background persistence | Foreground Service + WorkManager watchdog | No app-level watchdog needed — `DeviceActivityMonitor` extension runs independently | iOS doesn't need Android's "keep myself alive" pattern |

### Not possible on iOS — the honest "no" list, with the closest alternative

| Feature | Android mechanism | Why iOS can't do this | iOS alternative |
|---|---|---|---|
| Keyboard/content monitoring | Contracts only, never implemented (Sprint 3's own privacy gate) | Apple forbids third-party keystroke/content capture | None — never planned for Android either, per this project's own no-spyware principle |
| Arbitrary app blocking without Family Sharing setup | Works on any app the OS reports | `FamilyControls` REQUIRES prior Family Sharing enrollment | No alternative — hard Apple requirement |
| Reading which app is in the foreground, generally | `TYPE_WINDOW_STATE_CHANGED` | Apple hides this from third-party apps | `DeviceActivity`'s aggregate, delayed reporting only |

---

## MVP Definition for iPhone (Family Edition)

**In scope:** Parent App (already platform-independent Flutter —
confirmed this session), pairing via invite code, screen time
limit/bedtime via `ManagedSettings`/`DeviceActivity`, Dashboard
visibility (already works), APNs push.

**Explicitly NOT in iOS MVP:** keyboard/content monitoring (never
planned on any platform), app blocking without prior Family Sharing
enrollment (Apple hard requirement), real-time usage reporting matching
Android's cadence (Apple architecture limit), Enterprise MDM (separate,
later scope).

## Sequenced Implementation Steps (once Xcode/macOS is available)

1. Xcode project scaffold + a native `DeviceActivityMonitor` extension
   target (Apple's architecture requires this from step 1, not added later).
2. `AuthorizationCenter` consent flow via a Flutter platform channel
   (mirrors `AgentChannel.kt`'s bridge pattern, not reinvented).
3. `ManagedSettings` policy application — receives the same
   `ScreenTimePolicy` shape already sent to Android; no backend change.
4. `DeviceActivity` reporting → forwards to the existing
   `/pairing/device/heartbeat` endpoint — same contract, different sender.
5. APNs integration into `NotificationsModule`'s existing
   provider-agnostic layer.
6. TestFlight beta — the iOS equivalent of Android's real-device
   validation exit criterion.

## App Store Compliance Checklist (tracked here so it isn't forgotten)

- Privacy Nutrition Label accurately reflects `DeviceActivity`/`FamilyControls` data use
- Age rating appropriate for a parental-control category app
- Family Sharing enrollment requirement clearly explained before the consent sheet
- No permission requested beyond what `FamilyControls`/`ManagedSettings`/`DeviceActivity`/APNs actually need
