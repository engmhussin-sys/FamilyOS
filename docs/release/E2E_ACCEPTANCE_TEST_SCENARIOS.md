# End-to-End Acceptance Test Scenarios

**Status of every scenario below: ⚠️ NOT TESTED.** This sandboxed
environment has no live backend deployment, no physical Android/iOS
device, and no way to run the Parent App / Child App against each
other in real time. These are the scripted scenarios a real QA pass
must execute — written now so that pass is a checklist, not an
improvisation.

## Parent Scenario

| Step | Expected result | Verifies |
|---|---|---|
| 1. Register a new account | `POST /auth/register` succeeds, session stored | `AuthController.register` |
| 2. Set up family name | `PATCH /settings` succeeds | `FamilyApi.setupFamily` |
| 3. Add a child | `POST /children` succeeds, appears in list | Dashboard child list |
| 4. Generate a pairing code | `POST /pairing/invite` returns a code + expiry | `PairingApi.generateInviteCode` — uses the CURRENTLY correct endpoint, fixed this sprint |
| 5. Pairing succeeds from a real Child device | Device appears in Parent Dashboard | Full loop — cannot be verified without a real device |
| 6. Child appears with correct status | Dashboard shows child + device | `DashboardApi.getChildren`/`getDevices` |
| 7. Send a screen time policy | `POST /screen-time-policy` succeeds | `ScreenTimePolicyCard` |
| 8. Receive a heartbeat from the real device | `lastSeenAt` updates | `PairingOrchestratorService.recordHeartbeat` |
| 9. An alert/notification appears | Shows in Notification Center | `NotificationCenterCard` / Parent App `NotificationsScreen` |

## Child Scenario

| Step | Expected result | Verifies |
|---|---|---|
| 1. Install the app | App launches | No Flutter build toolchain in this environment |
| 2. Register/pair with a code | `POST /pairing/accept` succeeds | `PairingApi.accept` (Dart) |
| 3. Grant permissions | Accessibility + Overlay + Battery exemption all report enabled | The exact check fixed this session — this scenario is the real-world test that would have caught it, had it been runnable |
| 4. Reboot the phone | Foreground Service + Accessibility Service both restart | `BootReceiver.kt` |
| 5. Service keeps running | Persistent notification stays visible | `ChildGuardForegroundService` |
| 6. Disconnect internet | Local enforcement continues (policy cache) | `NativePolicyStore` + `PolicyEnforcer` — confirmed by code review this session |
| 7. Reconnect internet | Queued heartbeats drain | `OfflineQueue.drain()` — confirmed by code review this session |
| 8. Policy takes effect | Blocked app closes / bedtime enforced | `ChildGuardAccessibilityService` |
| 9. Accumulated data sends | Backend receives the queued events | Requires a live backend |

## Dashboard Scenario

| Step | Expected result | Verifies |
|---|---|---|
| Devices list | Shows all paired devices with trust/risk | `DeviceStatusCard` |
| Runtime Timeline | Shows pairing/policy/enforcement events | `RuntimeTimelineCard` |
| Notification Center | Shows + marks read | `NotificationCenterCard` |
| Family Insights | Shows AI recommendation + reasoning | `FamilyInsightsCard` |
| Reports | Generates + CSV export | `ReportsCard` |
| Search | Returns matching children/devices/notifications | `SearchBar` |
| Billing | Shows plan, allows trial start | `SettingsPage`'s Billing tab |
| Feature Flags | Reflects backend state | `GET /feature-flags` — no admin toggle UI yet, read-only via API |

## Why none of this could be executed this session

- No live backend instance running and reachable.
- No Flutter SDK — `flutter build apk`/`flutter run` cannot execute.
- No physical or emulated Android/iOS device.

**This document is the test PLAN. Running it is a distinct, required
activity before any Go decision**, per `RELEASE_ACCEPTANCE_CHECKLIST.md`'s
own Go/No-Go section.
