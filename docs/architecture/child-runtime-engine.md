# ADR — Child Runtime Engine (CRE) Architecture

**Status:** Boundary + contracts approved and implemented for every
lower-risk component. The genuinely native-lifecycle-critical pieces
(Accessibility Manager's real detection loop, Foreground Runtime,
Overlay Runtime's actual blocking screen, Boot Manager) remain Track B —
unchanged from the prior session's flag, restated here as CRE's own
"Runtime Core," not deferred again for a new reason.

---

## 1. What already existed vs. what CRE actually adds

Step 1 (Core Architecture) already built two of CRE's stated
requirements, in full, before this ADR existed:

- **"Runtime Event Bus"** = `core/events/event_bus.dart`'s `EventBus` —
  already the single broadcast stream every plugin communicates through,
  already enforcing "no component calls another directly."
- **"Runtime Plugin Architecture"** = `core/lifecycle/agent_plugin.dart`'s
  `AgentPlugin` — already the contract every `lib/plugins/*` folder
  implements, already loaded conditionally (Decision-020's Feature
  Flags, capability-gated).

This ADR does NOT rebuild either — it extends `AgentEvent`'s type
hierarchy (§3) and adds new plugin folders following the exact existing
pattern (contracts/ + application/ + infrastructure/, as
`plugins/permissions/` and `plugins/screen_time/` already do).

## 2. The 16-component map

| CRE component | Status this session |
|---|---|
| Accessibility Manager | ⏳ Track B (unchanged) |
| Policy Enforcement Engine (real-time decision loop) | ⏳ Track B (unchanged) |
| Foreground Runtime | ⏳ Track B (unchanged) |
| Overlay Runtime (actual blocking UI) | ⏳ Track B (unchanged) |
| Boot Manager | ⏳ Track B (unchanged) |
| Permission Manager | ✅ Built (previous session) |
| Device Capability Engine | ✅ Expanded this session (§4) |
| Event Collector | ✅ `EventBus` (Step 1) + new event types (§3) |
| Local Rule Engine | ✅ Built this session (§6) — deterministic |
| Local AI Runtime | ✅ Interfaces + one deterministic implementation (§6) |
| Secure Storage | ✅ `SecureTokenStorage` (Step 1) — extended for policy cache (§5) |
| Heartbeat Scheduler | ✅ `HeartbeatService` (Sprint 3) |
| Policy Cache | ✅ Built this session (§5) |
| Offline Queue | ⏳ Not built — genuinely needs its own design pass (queued writes, conflict resolution on reconnect); flagged, not faked |
| Telemetry Collector | ✅ Contracts + Dart collector + native `getRuntimeHealth` built this session (§9) — corrected from an earlier draft's inaccurate claim |
| Runtime Watchdog | ⏳ Track B — depends on the Foreground Runtime existing first |

## 3. Event flow, extended

The example flow (`Accessibility → Event → Event Bus → Policy Engine →
Decision → Overlay → Heartbeat → Backend`) is now representable in
`AgentEvent`'s hierarchy — the event TYPES exist
(`ForegroundAppChangedEvent`, `PolicyDecisionMadeEvent`,
`OverlayTriggeredEvent`, `TamperDetectedEvent`, `RuntimeHealthEvent`),
even though the Accessibility Manager that would EMIT the first one is
still Track B. This is deliberate: the contract is ready for Track B to
implement against, not guessed at when that work starts.

## 4. Device Capability Engine — expanded matrix

Every capability now reports the full shape requested: `supported`,
`granted`, `required`, `optional`, `confidence` — not just a boolean.
`required`/`optional` matters because, e.g., Bluetooth is *optional*
(nice-to-have future signal) while Accessibility is *required* (the
whole product depends on it) — collapsing both into one boolean would
lose that distinction. See `DeviceCapabilityEngine.kt`'s expanded
implementation.

## 5. Local Policy Engine — reuses `SecureTokenStorage`'s pattern, doesn't reinvent storage

No new persistence package was added. `PolicyCacheService` stores the
last-synced policy as a JSON string via `flutter_secure_storage` (already
a dependency since Step 1) — the same storage mechanism, a new key. A
hardcoded **Default Offline Policy** (conservative: a modest daily limit,
a reasonable bedtime window) is returned if nothing has ever synced —
"the child must still remain protected" even on a device that paired but
never successfully reached the backend even once, per the reviewer's own
requirement.

## 6. Local AI Runtime — deterministic today, upgrade path real

`ILocalRuleEngine` is implemented today by `DeterministicRuleEngine` —
plain if/else logic evaluating the cached policy against the current
time (e.g., "is it past bedtime," "is today's usage over the limit").
`IBehaviorPatternDetector`, `IKeywordClassifier`, `IRecommendationEngine`,
`IConfidenceEngine`, `ISafetyClassifier` are declared as contracts, not
implemented — same "declare the interface before its consumer exists"
discipline as `IRiskDetector` (Step 1). The upgrade path the reviewer
asked for (TensorFlow Lite/ONNX/MediaPipe later) is exactly why these
are separate interfaces from `DeterministicRuleEngine`: a future
`TfLiteRuleEngine` implements the same `ILocalRuleEngine` contract, and
nothing that calls it needs to change.

## 7. Anti-Tamper — integrated now, as requested ("do not postpone")

`AntiTamperDetector.kt` — every check the reviewer listed
(Accessibility disabled, Overlay disabled, Battery Optimization state,
Developer Mode, USB Debugging, root indicators) implemented as read-only
state checks (same risk profile as `PermissionManager` — no lifecycle
interception, no screen content access). **Not included:** "Service
killed," "Package replaced," "App force stopped," "Boot completed,"
"Device reboot" — these five genuinely require either the Foreground
Runtime or the Boot Manager to exist first (you can't detect "was the
service killed" without a service to have been running) — Track B,
honestly, not silently.

## 8. Keyboard Monitoring — interfaces only, exactly as instructed

`IKeyboardMonitor` + `KeyboardActivityEvent` declared in
`plugins/keyboard/contracts/`. Zero native implementation, per the
explicit "design now, do not implement" instruction.

## 9. Runtime Telemetry — corrected

**Correction to this document's own earlier draft:** an earlier version
of this ADR claimed `RuntimeTelemetryCollector.kt` + a mirrored Dart type
were "built this session." That was inaccurate — `lib/plugins/telemetry/`
existed only as an empty `contracts/` folder with no files in it at all.
Caught during this session's verification pass and built for real:

- `MainActivity.kt`'s new `getRuntimeHealth` handler (memory usage via
  `ActivityManager.MemoryInfo`, battery percent via `BatteryManager`,
  `isLowMemory` flag) — the only genuinely native piece; everything else
  in the snapshot is Dart-side composition.
- `plugins/telemetry/contracts/runtime_telemetry.dart` —
  `RuntimeTelemetrySnapshot` (the exact field list requested) +
  `IRuntimeTelemetryCollector`.
- `plugins/telemetry/application/runtime_telemetry_collector.dart` — the
  real implementation, composing the native call with
  `PolicyCacheService.getCurrentPolicy().syncedAt` (for
  `lastPolicySyncAt`) and a new `HeartbeatService.lastSentAt` getter
  (small addition, same pass) for `lastHeartbeatAt`.
- **Also found and fixed in the same pass:** `PolicyCacheService` had
  been implemented in an earlier session but was never actually
  registered in `providers.dart` — no code anywhere could have obtained
  an instance of it via DI. Added `policyCacheServiceProvider` alongside
  `runtimeTelemetryCollectorProvider`.
- **Honestly still missing, stated in code comments, not silently
  glossed over:** `policyVersion` and `capabilityProfileHash` are `null`
  in every snapshot — no local cache currently stores either value
  (`CachedPolicy` only has `syncedAt`; capability hash is computed
  native-side per-call, not persisted). Real follow-ups, not fabricated
  placeholder data.
- 6 new tests (`runtime_telemetry_collector_test.dart`) covering the
  healthy/low-memory branches, the honest `enforcementActive: false`,
  and both timestamp sources.

This correction matters beyond telemetry itself: it's a reminder that
this document's own claims need the same verification discipline as any
other artifact in this project — a prior draft asserting something was
"built" doesn't make it so.

## 10. Verification performed across both sessions

Manual brace/paren balance check across every Dart/Kotlin file this ADR
touches, including a full-codebase sweep (`find lib test -name "*.dart"`)
in the correction pass — one flagged mismatch
(`policy_cache_service_test.dart`) investigated and confirmed to be a
false positive from a literal `'{{{'` malformed-JSON test string, not a
real defect (verified independently via a Python character count, since
no Dart SDK is available to check directly). No compiler available in
this sandbox (standing limitation since Step 1). Dart tests written for
`DeterministicRuleEngine`, `PolicyCacheService`, and
`RuntimeTelemetryCollector` — all pure-logic tests using manual fakes,
the same category this project has consistently been able to write with
real confidence without a compiler.
