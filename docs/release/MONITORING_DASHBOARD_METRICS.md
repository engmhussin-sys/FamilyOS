# Monitoring Dashboard Metrics — Definitions

Every metric requested, defined precisely, and marked against real
current state: does the data to compute it already exist, or would it
need new instrumentation.

| Metric | Definition | Status |
|---|---|---|
| Active Devices | Devices with `lastSeenAt` within the last 7 days | ✅ Already computed — `DashboardMetricsService.getMetrics()`, Sprint 8 |
| Protected Devices | Active devices where `Device.lastTelemetry.accessibilityServiceEnabled == true` | ⚠️ Data exists but no aggregate query computes this today — small real addition |
| Heartbeat Delay | `now() - Device.lastSeenAt`, per device | ⚠️ Raw field exists; no delay-distribution (p50/p95) is computed anywhere |
| Offline Devices | Devices with `lastSeenAt` older than a defined staleness threshold | ❌ Not computed — needs a product decision (how stale is "offline"?) plus a new query |
| Queue Backlog | Sum of local offline-queue lengths across devices/parents | ❌ Not computable server-side at all — these queues are device/app-local, never reported to the backend; would need new instrumentation on both client and server |
| Runtime Errors | Count of logged 5xx responses / unhandled exceptions | ⚠️ Every error IS logged (Sprint 9) but not aggregated into a queryable metric — needs a log-aggregation provider, not chosen |
| Accessibility Disabled | Count of devices with accessibility reported off | ⚠️ Same as Protected Devices — data exists, aggregate query doesn't |
| Policy Sync Time | Time between a policy change and the device's next heartbeat reflecting it | ❌ Not computed — no field links a policy version to "confirmed applied at time Y" |
| Average Response Time | Backend API p50/p95 latency | ⚠️ `durationMs` is logged per request (Sprint 9) but not aggregated — needs a log-aggregation/APM provider |
| Push Delivery Rate | % of sent push notifications delivered/opened | ❌ Not computable — no push provider integrated at all yet; no data source exists |

## Honest summary

**~4 of 10 metrics are fully computable today or one small aggregation
query away** (Active Devices, Protected Devices, Accessibility
Disabled). **6 of 10 genuinely need new instrumentation** — some
client-side (Queue Backlog), some requiring a real infrastructure
decision this document can't make unilaterally (Runtime Errors and
Average Response Time both need a log-aggregation/APM provider), and
one (Push Delivery Rate) has no data source until push notifications
exist at all.

**Recommended sequencing:** Protected/Accessibility-Disabled first
(trivial) → Offline Devices (needs one product decision: staleness
threshold) → the rest, gated on provider decisions this document
correctly does not make unilaterally.
