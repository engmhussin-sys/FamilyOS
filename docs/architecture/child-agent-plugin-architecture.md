# Architecture Notes — Child Agent Contracts, Events & Plugin Structure

Covers Decisions 016–020. No enforcement logic exists yet — this document
and the files it describes are contracts and infrastructure only, per the
explicit "interfaces before implementations" instruction.

---

## 1. Where each interface lives, and why (Decision-016)

| Interface | Location | Why here, not elsewhere |
|---|---|---|
| `IAgent` | `core/contracts/` | The single top-level orchestrator — not a plugin, the thing that initializes plugins |
| `ICapabilityProvider` | `core/contracts/` | Every plugin queries it; making it a plugin itself would create a dependency plugins couldn't declare (plugins don't depend on plugins — see §3) |
| `IPolicyProvider` | `core/contracts/` | Cross-cutting — screen time, app blocking, and future health/education modules all need "what applies right now" |
| `IHeartbeat` | `core/contracts/` | Is the self-health-monitoring mechanism itself (lifecycle ADR §10), not a feature that can be disabled |
| `IPermissionManager` | `plugins/permissions/contracts/` | A genuinely toggleable concern with its own onboarding UI surface |
| `IAntiTamper` | `plugins/anti_tamper/contracts/` | Same — independently meaningful as a unit |
| `ISyncEngine` | `plugins/sync/contracts/` | Same |
| `IAppUsageCollector` | `plugins/screen_time/contracts/` | Usage collection only exists to feed screen-time enforcement/reporting in this project's current scope |
| `ILocationCollector` | `plugins/gps/contracts/` | Not yet scheduled in the 12-step order — included because Decision-016 named it explicitly; needs its own future build-order decision |
| `IRiskDetector` | `plugins/ai/contracts/` | On-device AI is its own substantial follow-on project (see the interface's own docstring) |

**The core/vs/plugin split rule going forward:** if a capability is
something every other module needs to *read* (capabilities, policy,
health), it's core. If it's an independently toggleable *feature* with
its own onboarding/UI/enable-disable lifecycle, it's a plugin. When in
doubt, default to plugin — core should stay small.

## 2. Event Bus (Decision-017)

`core/events/event_bus.dart` — a single `StreamController<AgentEvent>.broadcast()`
wrapped in `EventBus`, provided as a Riverpod singleton
(`core/di/providers.dart` — extended in this step). `core/events/agent_event.dart`
defines the sealed event hierarchy: `CapabilityChangedEvent`,
`PermissionRevokedEvent`, `PolicySyncedEvent`, `DevicePairedEvent`,
`DeviceSessionExpiredEvent`.

**The rule this structurally enforces:** a plugin holds a reference to
`EventBus` and to the core contracts it's injected with (via
`AgentPlugin.initialize(EventBus eventBus)`) — it never holds a reference
to another plugin's class. `Module A calls Module B` is not just
discouraged by convention, it's **impossible without an explicit import
of a sibling plugin package**, which code review can catch trivially (any
`import '../../other_plugin/...'` inside a plugin is a structural
violation, not a style nitpick).

Decision-017's own example — `Permission Revoked → Event → Policy Engine
→ Sync Engine → Parent Notification` — is exactly `PermissionRevokedEvent`
emitted once by the Permission Manager plugin, with the Policy Engine,
Sync Engine, and (future) Notification plugin each independently
subscribed via `eventBus.on<PermissionRevokedEvent>()`. No new mechanism
was needed beyond the bus itself to satisfy that example.

## 3. Plugin folder structure (Decision-018)

```
lib/
  core/                    — shared infrastructure, not a plugin
    config/ storage/ network/ platform/ di/    (Step 1)
    contracts/                                  (this step)
    events/                                      (this step)
    lifecycle/                                    (this step: AgentPlugin base + IAgent)
  plugins/
    permissions/contracts/   — Step 5
    screen_time/contracts/    — Steps 11–12
    gps/contracts/             — future, unscheduled
    health/                     — future, Phase 2 equivalent for the Agent
    keyboard/                    — future; see Android enforcement ADR §10's Play-policy risk note before building
    ai/contracts/                  — future, on-device model project
    anti_tamper/contracts/          — Step 9
    sync/contracts/                   — Step 7
```

Each plugin directory will eventually contain its own
`application/`/`infrastructure/`/`presentation/` split internally, mirroring
the backend module convention — that's a per-plugin decision made when
each one is actually implemented, not dictated globally here.

Every future concrete plugin implements `core/lifecycle/agent_plugin.dart`'s
`AgentPlugin` (id, `initialize(EventBus)`, `dispose()`) — this is what
makes "plugin" a structural fact (a shared interface every plugin
satisfies and the orchestrator iterates over), not just a naming
convention for folders that could just as easily have been called
`features/`.

## 4. Capability Cache (Decision-019)

Specified in `ICapabilityProvider`'s docstring: `getProfile()` may return
a cached result; `refresh()` forces a full re-scan and updates the cache.
The concrete Capability Engine (Step 4) is responsible for:
1. Computing `profileHash` (SHA-based, per Decision-019) over the full
   `CapabilityProfile`.
2. Comparing against the last-cached hash.
3. Only calling the backend with an update if the hash actually changed —
   this is the mechanism, not a vague "don't scan too often" guideline.

This directly serves the lifecycle ADR §10 distinction between the
expensive full scan (cached, infrequent) and the cheap per-heartbeat
permission recheck (frequent, not cached) — two different costs, two
different cadences, by design.

## 5. Feature Flags (Decision-020)

Not yet a built system — flagging the structural requirement now so
Step 5+ implementations are written against it from the start rather
than retrofitted:

- Every plugin's `AgentPlugin.initialize()` should check a per-family,
  per-plugin flag state (`enabled | disabled | beta | experimental`)
  fetched from the backend (not hardcoded) **before** doing any real
  work — an implementation that does setup work before checking its flag
  state has the check in the wrong place.
- Backend implication (not built in this step): this needs a
  `FeatureFlag` concept scoped to `Family` (or `SubscriptionPlan`, for a
  future paid-tier gating use case) — a schema/API addition for a future
  step, consistent with this project's practice of noting required-but-
  not-yet-built backend support rather than silently assuming it exists.

## 6. What was deliberately NOT built in this step

- No concrete implementation of any interface above — Decision-016 was
  explicit: interfaces first.
- No `FeatureFlag` backend support yet (§5).
- No Secure Pairing (Step 2 remains next, once this step is accepted).
