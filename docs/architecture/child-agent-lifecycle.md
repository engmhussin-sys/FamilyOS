# ADR — Child Agent Lifecycle Management

**Status:** Proposed — gates Step 2 (Secure Pairing) per the reviewer's
explicit instruction. No code in this document.

---

## 1. Startup sequence

1. Process starts (user tap, or one of the OS-triggered paths in §2–5).
2. Flutter engine + native Android init → `main.dart` runs → DI
   (`ProviderScope`) initializes.
3. An `AgentLifecycle` orchestrator (the concrete implementation of the
   `IAgent` contract from Decision-016) runs a strict sequence, each
   stage gated on the previous succeeding:
   a. Read `SecureTokenStorage` — is there a paired session?
   b. **If unpaired:** stop here. Show only the pairing UI. Nothing else
      below initializes — there is no capability profile, no policy, and
      nothing to enforce for a device that isn't registered to a family yet.
   c. **If paired:** run the Capability Engine's check (Decision-019:
      cached, not a full re-scan every time — see §10), confirm the
      Foreground Service is alive (start it if not), wire the Event Bus
      subscribers for every registered plugin, then trigger an initial
      Sync Engine heartbeat + policy pull.
4. Only after step 3c completes does the Agent consider itself
   "operational" — this is the state the Heartbeat payload reports.

## 2. `BOOT_COMPLETED` behavior

A native `BroadcastReceiver` (registered in the manifest, requires
`RECEIVE_BOOT_COMPLETED`) is the entry point — **not** the Flutter engine
directly, since spinning up a full Flutter engine on every device boot
purely to check "am I paired?" is unnecessarily heavy. The receiver reads
a lightweight native-side flag (mirrored from `SecureTokenStorage` at
pairing time specifically so this check doesn't need Flutter/Dart to run
first) and, if paired, starts the Foreground Service directly from native
code. That service can then bring up a headless Flutter engine
(`FlutterEngineGroup`) if Dart-side logic is needed for its ongoing work.

**Important nuance:** `AccessibilityService`, once the user has enabled it
in system settings, is managed and restarted by the OS's own accessibility
subsystem after boot — it does **not** depend on our boot receiver. The
receiver's actual job is narrower and specific: restart *our* Foreground
Service (the heartbeat/sync/policy-check loop), which is the one
component the OS does not restart on our behalf.

## 3. App update behavior

Android kills the process during install; there is no code running
"during" an update to hook into directly. Two mechanisms cover this:
- The app registers for `ACTION_MY_PACKAGE_REPLACED` (a broadcast Android
  sends specifically to an app that was just updated).
- On next process start (via that broadcast or a normal launch), compare
  the currently-running `PackageInfo.versionName` against the last-known
  version persisted in secure storage. A mismatch triggers a **post-update
  capability recheck** — not just resuming normal operation — because
  Android has, in past OS/Play Protect updates, occasionally disabled a
  previously-granted Accessibility Service as a security measure across
  app updates. Assuming permissions still hold after an update is an
  unsafe assumption; re-verifying is cheap and closes a real gap.

## 4. Device reboot behavior

Covered mostly by §2, with one addition: anything queued by the Offline
Sync Engine (Step 7 / Decision-011) **must be persisted to durable local
storage** (a local database, not an in-memory queue), specifically so a
reboot occurring before a sync completes does not silently drop queued
events. This is a hard requirement on Step 7's design, flagged here so it
isn't discovered as a gap later.

## 5. Process-killed behavior

These are two structurally different cases and must be handled
differently — conflating them would be a design mistake:

- **OS low-memory kill:** the Foreground Service returns `START_STICKY`
  from `onStartCommand()`, which is Android's standard mechanism for
  "please restart me after killing me for memory pressure." Combined with
  §6's watchdog, this is the expected, recoverable case.
- **User "Force Stop" (from Android Settings):** Android deliberately
  prevents an app from auto-restarting itself after an explicit user
  force-stop — this is intentional OS behavior respecting user intent,
  and there is no legitimate way to defeat it (nor should there be). This
  state can only end via the user manually reopening the app, or a
  subsequent device reboot (§2's boot receiver fires normally even after
  a prior force-stop). **This is precisely the strongest real-world case
  for the Anti-Tamper Framework**: a force-stopped Agent cannot self-heal,
  so the server-side heartbeat-gap detection is the only way to notice it
  happened, and that gap should generate a parent-facing notification.

## 6. Foreground service restart strategy

Two independent, redundant mechanisms — not one:
1. `START_STICKY` (self-restart, per §5) — not guaranteed to be honored
   identically across every OEM's modified Android build.
2. A periodic `WorkManager` "watchdog" job (practical minimum interval
   ~15 minutes, per WorkManager's own constraints) that checks whether the
   Foreground Service is actually running and restarts it if not. This is
   deliberate belt-and-suspenders redundancy for exactly the OEM
   inconsistency `START_STICKY` alone doesn't fully cover.

## 7. Background restrictions handling

Since Android 8's background execution limits, and increasingly Android
12+'s "hibernation" of unused apps plus OEM-specific background killers:
the honest position is that **there is no single reliable public API to
programmatically detect "am I currently background-restricted?"** across
every Android version and OEM skin — claiming otherwise would be
inaccurate. The realistic strategy is:
- **Prevention:** during onboarding (Permission Manager, Step 5),
  explicitly request the unrestricted/no-restrictions battery setting via
  its user-facing settings deep link, with a clear parent-facing
  explanation of why.
- **Detection by effect, not by cause:** rather than trying to detect
  every possible restriction mechanism, rely on the Heartbeat gap
  (§10) as the universal signal — *something* prevented normal operation,
  regardless of which specific OS/OEM mechanism caused it. This is more
  robust than an enumeration approach that will always be incomplete.

## 8. Battery optimization handling

Requested via the standard `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` intent
during onboarding — a Play-policy-compliant, recognized legitimate use
case for this app category. Critically, this exemption **can be silently
revoked later** (by the user, or by OS/OEM "optimize apps" prompts) — so
the Capability Engine's periodic re-check (§10, Decision-019) must
re-verify this each cycle, not assume a one-time grant holds forever. A
revocation is treated identically to any other capability regression:
emitted on the Event Bus, surfaced to the parent.

## 9. Crash recovery strategy

- **Native (Kotlin) crashes** in the Foreground Service or Accessibility
  Service: wrapped in structured try/catch with logging to a **persisted**
  local crash log (not in-memory-only — a crash that kills the process
  would lose an in-memory log with it), uploaded on the next successful
  sync. This doubles as the "Crash Reports" observability signal from
  Decision-013.
- **Dart-side crashes:** `FlutterError.onError` and
  `PlatformDispatcher.instance.onError` both wired to the same persisted
  crash log and Event Bus emission.
- **Architectural implication:** the native Foreground Service should be
  able to keep its core loop alive independent of whether a Flutter
  engine instance is currently attached — a Dart-layer crash must not be
  able to take the native monitoring loop down with it. This reinforces
  §2's headless-engine design: native code owns survival, Dart is
  attached opportunistically.

## 10. Agent self-health monitoring

A single internal health-check routine — this is the concrete
implementation of the `IHeartbeat` contract — runs on the same cadence as
the Sync Engine and inventories, fresh each time (not cached from initial
grant): Accessibility currently enabled?, Usage Access currently
granted?, Foreground Service's last `onStartCommand` timestamp recency,
battery level/thermal-throttling state, and the current size of the
pending offline-sync queue (a growing queue is itself an unhealthy
signal, independent of its cause). **This health snapshot IS the
Heartbeat payload** (Decision-013's Heartbeat/Health/Battery/Storage/
Connectivity/Last-Sync/Capability-Changes list) — self-health-monitoring
and the Heartbeat mechanism are the same system, not two separate ones
that need to be kept in sync with each other.

**Cache discipline (Decision-019):** the *full* Capability scan (device
model, OEM restrictions lookup, etc.) runs once and is cached by hash;
what runs every heartbeat cycle is the cheaper permission/service-state
recheck above — these are different costs and different frequencies by
design, not the same operation run redundantly.
