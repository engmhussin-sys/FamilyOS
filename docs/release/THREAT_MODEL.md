# Threat Model — Child Runtime Evasion

Every threat below is scored against what `AntiTamperDetector.kt`
(Sprint 4) actually checks today — verified by reading that file this
session. 7 of the 18 threats below have a real detection signal; 11 do
not. **Also verified this session, via a full backend grep: none of
these 7 signals are consumed anywhere in the backend's risk scoring
(`RiskEvaluationService`) today** — `AntiTamperDetector.checkAll()`
computes real signals on-device that currently go nowhere. This is
stated as a finding, not softened.

| Threat | Detection | Prevention | Recovery | Remaining Risk |
|---|---|---|---|---|
| Child deletes the app | ❌ None | ❌ Not possible without Device Owner (MDM) | Parent sees the device go silent (`lastSeenAt` stops updating) — an inference, not a direct signal | **High** — no distinct "uninstalled" event exists; looks identical to "phone is off" |
| Child disables Accessibility | ✅ `accessibility_disabled` signal | ❌ Nothing prevents the OS-level toggle | `ChildGuardForegroundService`'s watchdog flips within 60s; parent sees it via Dashboard | **Medium** — detected and surfaced, but enforcement genuinely stops until re-enabled |
| Child force-stops the service | ⚠️ Named in the original design (`serviceDisabled`) but explicitly NOT implemented | `START_STICKY` requests OS restart, best-effort per Device Validation Matrix's OEM notes | Watchdog catches it on next successful restart | **High** — no direct detection signal exists today |
| Child changes system time | ❌ None | N/A | N/A | **Medium** — could affect bedtime-window timing; no detection or mitigation exists |
| Child boots into Safe Mode | ❌ None | ❌ Third-party services do not run in Android Safe Mode — an OS restriction, not something this codebase can override | Resumes automatically on next normal boot | **High while in Safe Mode** — real, unclosable gap on stock Android, not unique to this app |
| Factory Reset | ❌ None | ❌ Not possible without Device Owner/MDM | Re-pairing required from scratch | **High** — expected/accepted risk for a non-MDM-enrolled consumer app |
| Root | ✅ `root_detected` (su-binary paths + test-keys build tag) | ❌ Detection only | Signal computed device-side but **NOT sent to or used by the backend today** — verified via grep this session | **Medium-High** — heuristic only, and currently a dead-end signal |
| Magisk (hides root from naive checks) | ❌ None | ❌ N/A | N/A | **High** — the su-path/test-keys heuristic is exactly what Magisk's hide-root feature defeats; a dedicated library (RootBeer or equivalent) is the real production answer, not implemented |
| Frida (dynamic instrumentation) | ❌ None | ❌ N/A | N/A | **High** — no anti-Frida/anti-hooking detection exists anywhere |
| USB Debugging | ✅ `usb_debugging_enabled` | ❌ Detection only | Same dead-end as root — computed, not transmitted/consumed | **Low-Medium** — enabling this alone doesn't defeat enforcement by itself |
| Emulator | ✅ `emulator_detected` (build fingerprint heuristics) | ❌ Detection only | Same dead-end | **Medium** — fingerprint-based, defeatable by a well-configured custom ROM |
| VPN | ❌ None | N/A | N/A | **Low for enforcement** (local policy enforcement doesn't depend on network path); **N/A today** for content filtering (not built) |
| DNS Bypass / Private DNS / Proxy | ❌ None | N/A | N/A | **N/A today** — no DNS/content-filtering feature exists to bypass |
| Hotspot | ❌ None, and N/A | N/A | N/A | **N/A** — no network-level filtering exists to bypass |
| Multiple Users (Android multi-user profiles) | ❌ None | ❌ Nothing prevents switching to an unmanaged secondary profile | N/A | **High** — the app only enforces within the profile it's installed in; a secondary profile is effectively unmonitored |
| Work Profile | ❌ None | ❌ Same class of gap as Multiple Users | N/A | **High** — same reasoning |
| Developer Mode enabled | ✅ `developer_mode_enabled` | ❌ Detection only | Same dead-end | **Low** — a precursor signal, useful as early warning, not a threat by itself |
| Mock Location | ✅ `mock_location_detected` | ❌ Detection only | Same dead-end | **Low** — relevant to location-based features (`LocationSafeZone`), not screen-time enforcement |

## Honest summary

**7 of 18 threats have a real, working on-device detection signal.**
**Zero of those 7 currently reach the backend or influence any risk
score, notification, or parent-facing alert** — this is a genuine,
previously-undocumented integration gap surfaced by this review, not a
design decision. **Zero of the 18 have active prevention** beyond what
the OS itself enforces. **Detection-and-surface-to-parent, not
prevention-or-block, is this project's actual intended security model**
for a non-MDM-enrolled consumer device — consistent with the "no
jailbreak, no private APIs, no Device Owner" constraint already
established for the Family edition — but that model isn't fully wired
end-to-end yet: the detection half works, the surfacing half doesn't.

**Recommended priority for a future hardening sprint:** (1) wire the 7
existing signals into `DeviceRiskAssessment`/`RiskEvaluationService` —
the cheapest fix, since the signals already exist; (2) Multi-user/Work
Profile evasion; (3) Magisk/Frida detection.
