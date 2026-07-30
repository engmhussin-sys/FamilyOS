# Device Validation Matrix

**Every cell below is ⚠️ NOT TESTED.** No physical device exists in any
environment this project has been built in. This matrix is the
required test plan for the Validation phase, not a report of results.

## Coverage Matrix

| Manufacturer | Android Versions | Result |
|---|---|---|
| Samsung | 13 / 14 / 15 | ⚠️ NOT TESTED |
| Xiaomi | 13 / 14 | ⚠️ NOT TESTED |
| Huawei | 12 / 13 | ⚠️ NOT TESTED |
| Honor | 13 | ⚠️ NOT TESTED |
| Oppo | 13 | ⚠️ NOT TESTED |
| Vivo | 13 | ⚠️ NOT TESTED |
| OnePlus | 13 / 14 | ⚠️ NOT TESTED |
| Google Pixel | 14 / 15 | ⚠️ NOT TESTED |

## Per-Manufacturer Checklist

Each item must be individually marked PASS/FAIL/NOT TESTED per
manufacturer — a single "device works" checkbox is not sufficient
given how differently these subsystems behave per OEM skin.

| Item | Samsung | Xiaomi | Huawei | Honor | Oppo | Vivo | OnePlus | Pixel |
|---|---|---|---|---|---|---|---|---|
| Battery Optimization | ⚠️ NOT TESTED | ⚠️ NOT TESTED — known highest risk: MIUI's battery manager is separate from and stricter than stock `isIgnoringBatteryOptimizations` | ⚠️ NOT TESTED — known highest risk: no Google Play Services on newer devices; EMUI's "Protected Apps" is a second, separate permission | ⚠️ NOT TESTED — inherits MagicOS's own power management | ⚠️ NOT TESTED — ColorOS has its own "Startup Manager" | ⚠️ NOT TESTED — FuntouchOS has its own background management | ⚠️ NOT TESTED — OxygenOS closer to stock but still has "Advanced Optimization" | ⚠️ NOT TESTED — closest to what `PermissionManager` was written against |
| Auto Start | ⚠️ NOT TESTED | ⚠️ NOT TESTED — MIUI's separate "Autostart" toggle, off by default, not covered by any code here | ⚠️ NOT TESTED — same class of gap | ⚠️ NOT TESTED | ⚠️ NOT TESTED | ⚠️ NOT TESTED | ⚠️ NOT TESTED | ⚠️ NOT TESTED — stock Android has no separate autostart permission |
| Accessibility | ⚠️ NOT TESTED | ⚠️ NOT TESTED | ⚠️ NOT TESTED | ⚠️ NOT TESTED | ⚠️ NOT TESTED | ⚠️ NOT TESTED | ⚠️ NOT TESTED | ⚠️ NOT TESTED — the component-name bug fixed this sprint was never verified against a real `ENABLED_ACCESSIBILITY_SERVICES` string on ANY target |
| Foreground Service | ⚠️ NOT TESTED | ⚠️ NOT TESTED — MIUI is documented industry-wide as most aggressive at killing foreground services despite `START_STICKY` | ⚠️ NOT TESTED | ⚠️ NOT TESTED | ⚠️ NOT TESTED | ⚠️ NOT TESTED | ⚠️ NOT TESTED | ⚠️ NOT TESTED |
| Boot Receiver | ⚠️ NOT TESTED | ⚠️ NOT TESTED | ⚠️ NOT TESTED | ⚠️ NOT TESTED | ⚠️ NOT TESTED | ⚠️ NOT TESTED | ⚠️ NOT TESTED | ⚠️ NOT TESTED |
| Notifications | ⚠️ NOT TESTED | ⚠️ NOT TESTED | ⚠️ NOT TESTED | ⚠️ NOT TESTED | ⚠️ NOT TESTED | ⚠️ NOT TESTED | ⚠️ NOT TESTED | ⚠️ NOT TESTED |
| App Kill Behavior | ⚠️ NOT TESTED | ⚠️ NOT TESTED — MIUI's swipe-to-kill known to bypass `START_STICKY` on many versions | ⚠️ NOT TESTED | ⚠️ NOT TESTED | ⚠️ NOT TESTED | ⚠️ NOT TESTED | ⚠️ NOT TESTED | ⚠️ NOT TESTED |

## What the "known highest risk" notes are based on

Publicly documented, well-known Android OEM behavior — flagged because
`RuntimeWatchdogWorker`/`ChildGuardForegroundService` (`START_STICKY`)
assumes process-lifecycle guarantees MIUI and EMUI-family skins are
widely known to violate more aggressively than others. Exactly why
Sprint 4/5's exit criterion always specified 3 manufacturers, not one device.

## Validation Procedure (per cell above)

1. Fresh install, grant all permissions via the in-app flow.
2. Verify Accessibility shows enabled via the app's own status check —
   cross-reference Settings > Accessibility to catch a repeat of this
   sprint's component-name bug class.
3. Force-reboot; wait 2 minutes; verify the persistent notification reappears unopened.
4. Swipe the app from Recents; wait 5 minutes; verify the Foreground Service notification persists.
5. Airplane mode 10 minutes; verify local enforcement continues; disable; verify heartbeats drain within one cycle.
6. Manually revoke Accessibility; verify the watchdog notification flips to "needs attention" within 60s.
