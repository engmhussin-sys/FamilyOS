# Known Limitations — v1.0 Release Candidate

Consolidated from every honesty flag raised across Sprints 1–10.

## Platform limitations (not bugs — architectural facts)

- **Android enforcement is "instant-close-loop," not a true block.**
  Without Device Owner provisioning, `AccessibilityService` detects and
  closes a blocked app after it briefly launches — it cannot prevent
  the launch itself.
- **No iOS app exists.** See `MOBILE_RELEASE_CHECKLIST.md` and
  `docs/architecture/IOS_ARCHITECTURE.md`.
- **`DeviceActivity` (future iOS) reporting cadence is OS-scheduled, not
  real-time** — will never match Android's ~30s heartbeat once built.

## Security gap, not yet fixed

- **No endpoint-specific rate limit on `POST /billing/subscribe`**
  beyond the global default (100 req/min). The `MANUAL` payment adapter
  always succeeds, so a scripted client could generate many `ACTIVE`
  subscriptions without a real payment. Flagged in `SECURITY_REVIEW.md`.

## Missing integrations (interfaces exist, config doesn't)

- **Payment providers**: only `MANUAL` is production-usable. Stripe/
  Paymob/Fawry/Apple IAP/Google Play all have complete, real adapter
  code that throws a clear `PaymentProviderNotConfiguredException`
  until their respective API credentials are supplied.
- **Analytics**: only the self-hosted adapter is active. `PostHogAdapter`
  exists and silently no-ops without `POSTHOG_API_KEY`.
- **Push notifications**: no APNs/FCM integration exists. Only in-app
  `Notification` rows (Sprint 8) work today.
- **Storage/file uploads**: no provider integrated at all.
- **MDM platforms**: architecture documented, zero implementation.

## Data/reporting gaps

- **No per-app usage breakdown.** Reports are built entirely from
  Trust/Risk history, Screen Time policy, and AI Decision history —
  real data — but there is no `UsageStatsManager` aggregation pipeline.
- **Behavioral Intelligence Engine's trend detection is a first pass**
  — real, computed from actual Risk/Trust history, but does not cover
  app-usage-pattern anomalies since that data pipeline doesn't exist.

## Operational / infrastructure (not application code)

- **Backup & Restore**: depends entirely on the chosen hosting
  provider's managed-Postgres backup policy.
- **Load testing, penetration testing**: cannot be performed against a
  sandboxed, non-deployed instance. Both remain required before public launch.
- **No background job scheduler** exists (confirmed via codebase-wide
  grep). `DataRetentionEnforcementService` is written and ready to be
  called by one, once chosen.

## Multi-Tenant / Organization Platform

- **`Organization` and its four satellite tables have zero rows and
  zero readers.** Intentional — schema/interfaces exist to prevent a
  future redesign, not because the feature is implemented.

## Testing gaps

- **`test/database/schema.spec.ts`** requires a live Postgres instance;
  wired into CI against a real ephemeral Postgres service, but not run
  in this sandboxed environment.
- No dedicated unit tests exist for `ReportsService`, `SearchService`,
  or `DashboardMetricsService`.
