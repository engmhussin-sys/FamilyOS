# ADR — Child Agent: Android Policy Enforcement Architecture

**Status:** Proposed — blocks all Child Agent implementation until accepted.
**Scope:** Android only. iOS requires a separate ADR (fundamentally different
APIs — see §9).
**Constraint honored:** No code in this document, per the explicit request
this ADR answers. This is the architecture only.

---

## Executive answer

We will use **`AccessibilityService` + `UsageStatsManager` + a Foreground
Service**, not direct app-killing from Flutter. Flutter has no OS-level
authority to close another app; every real enforcement action happens in
native Android code (Kotlin) that Flutter calls into via a platform
channel — Flutter is the UI/orchestration layer, not the enforcement
layer. This is architecturally identical to how every legitimate
third-party parental-control app on Android works today (Google's own
Family Link is the one exception, and it works differently — see §4).

---

## 1. Which Android APIs will be used?

| API | Purpose |
|---|---|
| `UsageStatsManager` | Per-app usage duration, query historical usage for reports/daily totals |
| `AccessibilityService` | **Real-time** foreground-app detection (`TYPE_WINDOW_STATE_CHANGED` events) — this is what actually makes enforcement instant instead of polling-delayed |
| Foreground `Service` (`START_STICKY`, with a persistent notification) | Keeps the Agent alive under Android 8+ background execution limits |
| `SYSTEM_ALERT_WINDOW` (overlay) | Draws the "time's up" / "app blocked" screen over the blocked app |
| `PackageManager` | Enumerate installed apps for the App Catalog (already in our schema as `AppCatalogEntry`) |
| `DevicePolicyManager` (Device Admin, and optionally Device Owner) | **Optional, advanced mode only** — see §4 |
| `WorkManager` / `AlarmManager` (exact, `setExactAndAllowWhileIdle`) | Scheduled sync fallback if the foreground service gets killed |
| `ConnectivityManager` | Detect connectivity for the sync engine's retry/backoff logic |
| `NotificationManager` | The mandatory persistent foreground-service notification (Android requires this to be visible — we cannot hide it; being transparent about "monitoring is active" is also the right call for a "not spyware" product) |

## 2. Will `AccessibilityService` be required?

**Yes — mandatory**, not optional, for the default (non-Device-Owner)
path. It is the only Android API that gives us near-instant, reliable
foreground-app-change events without expensive polling. Without it,
"App Blocking" degrades to a polling loop (checking `UsageStatsManager`
events every N seconds) which is slower, more battery-hungry, and easier
for a child to briefly slip through.

**This carries real, non-technical risk that must be tracked as a project
risk, not just a technical footnote:** Google Play's Accessibility API
policy restricts this service to apps whose *core function* is
accessibility, with a narrow, reviewed exception process for
"parental control" / "device management" categories. Google has
periodically tightened enforcement (a wave of parental-control app
removals occurred in 2019–2020) and requires a specific in-app
disclosure flow and a Play Console declaration justifying the usage.
**Action item:** budget explicit time for Play Console's Accessibility
declaration form and prominent in-app disclosure before AccessibilityService
usage — this is a policy/compliance dependency, not just a coding task.

## 3. Will `UsageStatsManager` be used?

**Yes — mandatory.** Used for:
- Populating `AppUsageLog` (daily aggregated minutes per app — matches
  the schema's design, which already deliberately stores aggregates, not
  raw event logs).
- Cross-checking/reconciling AccessibilityService's real-time tracking
  (defense in depth — if the Agent was killed and restarted, `UsageStatsManager`
  can backfill usage that happened while the Agent was down, within the
  OS's retention window).

Requires the user to manually grant **"Usage Access"** — this is a
special-access setting (`Settings.ACTION_USAGE_ACCESS_SETTINGS`), not a
runtime permission dialog. The Agent must deep-link to this screen during
onboarding with clear instructions, since there is no way to
programmatically grant it.

## 4. Will Device Admin or Device Owner mode be supported?

**Device Admin (legacy):** Not recommended as a primary mechanism —
Google has been deprecating Device Admin APIs for consumer use in favor
of Device Owner/Profile Owner (Android Enterprise) for years; new
restrictions keep landing on general Device Admin capabilities.

**Device Owner:** **Optional "Enhanced Mode," not the default path**, for
one structural reason: Device Owner can only be provisioned on a device
that has **no Google account yet added** — practically, this only works
for a factory-reset or brand-new device, provisioned via QR code during
Android's Setup Wizard. It **cannot** be retroactively enabled on a
child's existing, already-set-up phone. This is exactly why Google
Family Link doesn't rely on it for typical family use either — Family
Link uses a Google-account-level "supervised account" mechanism that is
**not available to third-party apps**; we have no equivalent privileged
path.

**Recommendation:**
- **Default path (must work on any existing device):** AccessibilityService
  + UsageStatsManager + Overlay + Foreground Service, as described above.
- **Enhanced Mode (optional, advertised for "a new device set up for your
  child"):** Device Owner provisioning via QR code, unlocking
  `setPackagesSuspended()` / `setApplicationHidden()` for true OS-level app
  blocking and `setUninstallBlocked()` to prevent the child from removing
  the Agent. This should be a distinct, clearly-labeled setup path in the
  Parent App, not assumed as the default.

## 5. Mandatory permissions

| Permission / Access | Type | Notes |
|---|---|---|
| Usage Access (`PACKAGE_USAGE_STATS`) | Special access, manual toggle | Required for §3 |
| Accessibility Service enabled | Special access, manual toggle | Required for §2 |
| Display over other apps (`SYSTEM_ALERT_WINDOW`) | Special access | Required to show the block/limit-reached screen |
| `POST_NOTIFICATIONS` | Runtime (Android 13+/API 33+) | Foreground service notification is mandatory and must be visible |
| `FOREGROUND_SERVICE` (+ correct `FOREGROUND_SERVICE_*` type on Android 14+/API 34+) | Manifest | Keeps the Agent alive |
| Battery optimization exemption (`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`) | Special intent-based ask | See §10 — even granted, manufacturer battery managers can still override this |
| `INTERNET` / `ACCESS_NETWORK_STATE` | Normal | Policy sync, heartbeat |

## 6. Optional permissions (feature-gated, consent-gated)

| Permission | Only needed for | Notes |
|---|---|---|
| `ACCESS_FINE_LOCATION` + `ACCESS_BACKGROUND_LOCATION` | Location & Safety module | Android 10+ requires a **second**, separate runtime prompt for background location, and Play Store requires a prominent in-app disclosure screen shown *before* the system prompt |
| Device Owner provisioning | Enhanced Mode (§4) | Not requested by default |
| Camera / Microphone | **Not requested at all**, by design | Nothing in our current feature set needs them; explicitly not requesting them is itself a meaningful "not spyware" signal worth keeping in product marketing |
| `BIND_NOTIFICATION_LISTENER_SERVICE` | Not currently planned | Would enable reading notification content — high privacy sensitivity, conflicts with this project's stated data-minimization principle; recommend NOT building this without a dedicated privacy/product review, separate from this ADR |
| `READ_SMS` / `READ_CALL_LOG` | Not currently planned | Play Store restricts these to default SMS/Phone-handler apps only since 2019 — effectively unavailable to us unless we became the child's default messaging app, which is a large, separate product decision |

## 7. How will Screen Time actually be enforced?

1. `AccessibilityService` receives `TYPE_WINDOW_STATE_CHANGED` for the
   newly foregrounded package.
2. The Agent checks: does this package belong to a category/child with an
   active `ScreenTimePolicy` (already in our schema), and has today's
   accumulated usage (from local tracking, reconciled against
   `UsageStatsManager`) reached `dailyLimitMinutes`?
3. If the limit is reached: the Agent immediately (a) draws the overlay
   block screen (`SYSTEM_ALERT_WINDOW`) and (b) fires
   `Intent.ACTION_MAIN` + `CATEGORY_HOME` to return the child to the
   launcher, so the blocked app isn't just covered but actually backgrounded.
4. If the child re-opens the same app, step 1 fires again immediately —
   this is a **reactive, near-instant re-block loop**, not a one-time
   check. This is the realistic mechanism without Device Owner; it is not
   literally "impossible to open," it is "immediately kicked back out,"
   which is the same mechanism essentially every non-Device-Owner
   parental control app on Android uses.
5. Bedtime windows use the identical mechanism, triggered by a time check
   instead of a usage-minutes check.

## 8. How will App Blocking actually be enforced?

**Identical mechanism to §7**, just checked against `AppBlockRule` instead
of a time budget: if the foregrounded package matches a `BLOCK` rule (or
a `TIME_LIMIT` rule that's exhausted), the same overlay + home-intent
sequence fires. There is no separate "blocking engine" — Screen Time and
App Blocking are two policy sources feeding the same enforcement loop.

**Enhanced Mode exception:** with Device Owner, `setPackagesSuspended()`
provides true OS-level blocking (the app literally won't launch, no
reactive kick-out needed) — strictly better, but only available on
provisioned devices (§4).

## 9. What Android versions will be supported?

- **`minSdkVersion` 26 (Android 8.0 Oreo).** This is where foreground
  service behavior and background-execution limits stabilized into
  roughly their modern form — targeting lower would mean maintaining
  meaningfully different background-execution code paths for negligible
  real-world device coverage today.
- **`targetSdkVersion`:** must track Google Play's current mandatory
  target API level (Play Console enforces a rolling requirement, updated
  ~annually). This is a moving target by policy, not a fixed number to
  lock into this ADR — CI should have a recurring reminder to bump it
  each cycle.
- **iOS is explicitly out of scope for this ADR.** iOS enforcement would
  use Apple's `FamilyControls` / `ManagedSettings` / `DeviceActivity`
  frameworks, requires a special Apple-granted entitlement application,
  and has no equivalent to AccessibilityService (Apple deliberately
  prevents that class of cross-app introspection). This needs its own
  ADR before any iOS Child Agent work starts — the two platforms are not
  a shared codebase for the enforcement layer, only Flutter's UI shell
  can realistically be shared.

## 10. What cannot be implemented because of Android security restrictions?

Stated plainly, because honesty here is the whole point of this ADR:

- **True "cannot be opened at all" blocking is not possible without
  Device Owner mode.** The default path is "opened, then immediately
  kicked out" — a fast reactive loop, not a preventive lock. Product
  copy and parent-facing UI must describe this accurately, not oversell
  it as instant/impossible-to-bypass.
- **A technically capable child can defeat the default (non-Device-Owner)
  path entirely**, by: disabling Accessibility Service manually in
  Settings, revoking Usage Access, force-stopping the Agent, or
  uninstalling it outright. None of this is preventable without Device
  Owner's `setUninstallBlocked()`. The Agent should detect and report
  "protection disabled" states (Accessibility/Usage Access toggled off)
  as a parent-facing alert — we can't prevent circumvention on a
  standard device, but we can make it visible.
- **Reading content inside other apps** (e.g. message text within a
  third-party chat app) is both technically restricted by app sandboxing
  and, where AccessibilityService could theoretically read on-screen
  text, is squarely the kind of usage Google Play polices hardest. Not
  recommended, independent of technical feasibility.
- **SMS/Call log access** effectively requires becoming the child's
  default SMS/Phone app (2019+ Play policy) — out of scope for the
  current product without a separate, deliberate decision.
- **Manufacturer battery-management behavior** (Xiaomi/MIUI, Huawei/EMUI,
  Oppo/ColorOS, and similar aggressive battery managers) can kill the
  Agent's background service **even with the official Android battery
  optimization exemption granted** — this is OEM-layer behavior outside
  standard Android APIs entirely, and can only be mitigated (never fully
  solved) by directing users to manufacturer-specific autostart/whitelist
  settings screens. This is precisely the gap the Device Capability
  Engine below is designed to surface, not hide.
- **Keyboard Behavior Analysis** (from the original project scope): the
  only Play-policy-safe implementation is a **custom keyboard (IME)** the
  child must actively select as their system keyboard — trivially
  bypassed by switching keyboards, and a real adoption/friction problem.
  The AccessibilityService alternative (reading typed text globally)
  carries the same Play policy risk flagged in §2, at a higher severity.
  Recommend treating this as a separate, carefully-scoped future ADR, not
  bundled into the Child Agent MVP.

---

## Endorsed addition: Device Capability Engine

Agreed — this should be a formal Agent component, run **before** any
policy is applied, and is genuinely necessary given §10's list of
device-dependent gaps, not a nice-to-have.

**Capability Profile — collected on first launch and after any Agent
update, sent to the backend:**

| Field | Why it matters |
|---|---|
| Android version / API level | Determines which enforcement mechanisms are even available |
| Manufacturer / OEM (`Build.MANUFACTURER`) | Flags known-problematic OEMs (Xiaomi, Huawei, Oppo, etc.) for tailored onboarding instructions |
| Device Owner eligible? (was the app provisioned as Device Owner, yes/no) | Determines Default vs. Enhanced Mode |
| Usage Access granted? | Enforcement can't run without it — surfaced to parent if false |
| Accessibility Service enabled? | Same |
| Overlay permission granted? | Same |
| Foreground service currently alive? (self-reported heartbeat) | Detects "silently killed" state |
| Battery optimization exemption granted? | Doesn't guarantee survival (OEM-level), but its absence is a strong negative signal |

**Backend implication (schema change needed later, not written in this
ADR):** this profile needs a persisted home — most naturally a new
`DeviceCapabilityProfile` table (or an extension of the existing `Device`
table) capturing the fields above plus `lastReportedAt`. Flagging this as
a required, but not-yet-written, schema addition — consistent with "no
code in this document."

**How the backend uses it:** before showing a policy as "active" in the
Parent App/Dashboard, cross-check the child device's latest Capability
Profile. If Accessibility is disabled or the Agent hasn't heartbeated
recently, surface that honestly ("protection is currently off on
[device]") rather than implying a policy is enforced when it structurally
cannot be right now.

---

## Confirmed: Decision-004 and the resulting build order

Agreed without changes. No new Dashboard/AI/Compliance features until the
Child Agent's foundation works end-to-end. Proposed build order for the
Agent itself, matching the request's own list:

1. Device Registration + Pairing consumption (redeems the
   `/auth/devices/pairing/confirm` endpoint that already exists) + secure
   token storage on-device.
2. Device Capability Engine (must run before anything claims to enforce
   a policy).
3. Permission Manager (onboarding flow requesting/deep-linking every
   permission in §5, with honest state reporting per §10).
4. Foreground Service + Heartbeat + Background Sync Engine.
5. Policy Sync (pull `ScreenTimePolicy`/`AppBlockRule` from the existing
   backend endpoints).
6. Screen Time + App Blocking enforcement loop (§7/§8) — the first real
   enforcement capability.
7. App Usage Monitor (`UsageStatsManager` reconciliation → `AppUsageLog`).

Everything AI/Health/Education/Compliance-related stays paused until
step 6 is proven working on at least one real device across the OEM
diversity the Capability Engine is designed to detect.
