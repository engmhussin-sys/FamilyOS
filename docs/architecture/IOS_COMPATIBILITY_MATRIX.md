# iPhone Compatibility Matrix

The official reference for the iOS team — extracted from
`IOS_ARCHITECTURE.md`/`IOS_IMPLEMENTATION_PLAN.md`'s reasoning into one
scannable table. No Swift code, no implementation — status only.

| Feature | Android | iPhone | Note |
|---|---|---|---|
| Pairing | ✅ | ✅ | Same backend contract (`/pairing/invite`, `/pairing/accept`) |
| Screen Time | ✅ | ✅ | via `ManagedSettings` |
| App Blocking | ✅ (overlay-based) | ✅ | via `FamilyControls` — genuinely stronger once built (OS-level shield vs. Android's detect-and-close) |
| Usage Stats | ✅ (`UsageStatsManager`, near-real-time) | ⚠️ Different | `DeviceActivity` is OS-scheduled, not real-time — a real latency difference, not a missing feature |
| Overlay (block screen) | ✅ | ❌ | Not applicable — `ManagedSettings` prevents the app from opening at all, no overlay needed |
| Accessibility-based Enforcement | ✅ | ❌ | No iOS equivalent for third-party apps; `ManagedSettings`/`DeviceActivity` is the entire replacement, not a gap |
| Device Activity Reporting | — | ✅ | iOS-native concept, no Android equivalent |
| Push Notifications | 🔲 Planned (FCM) | 🔲 Planned (APNs) | Neither implemented yet; `NotificationsModule`'s data layer is provider-agnostic for both |
| Keyboard/Content Monitoring | ❌ Never planned | ❌ Not possible | Shared, intentional non-feature on both platforms |
| Background Enforcement | ✅ (Foreground Service + watchdog) | ✅ (structurally stronger — OS-side, not app-lifecycle-dependent) | iOS doesn't need Android's "keep myself alive" pattern |
| Enterprise/MDM | 🔲 Architecture only | 🔲 Architecture only | Both platforms |

**Legend:** ✅ implemented/available · ❌ not applicable or not possible
· ⚠️ available with a real behavioral difference · 🔲 planned, not yet built.

See `IOS_IMPLEMENTATION_PLAN.md` for the full feature-parity table with
reasoning per row, and the MVP scope definition.
