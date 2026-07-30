# FamilyOS — Release 1.0

## Features Included

- Auth, Family + Children management
- Pairing (Trust L0–L5 state machine, Risk scoring)
- Screen Time policy (daily limit, bedtime, focus mode)
- Runtime Recovery (Offline Queue, Recovery Coordinator, Watchdog)
- Internal AI Platform (7 engines) — zero external-LLM dependency for any decision
- Notification Center, Billing (6 provider adapters, `MANUAL` production-usable), Feature Flags, Profile, Settings
- Reports (CSV export), Global Search, Analytics Core (self-hosted, PII-filtered)
- Admin Dashboard (React) — full Arabic/English localization, RTL
- Parent App (Flutter, Android + iOS-ready code) — Foundation: auth, family setup, dashboard, pairing, notifications, settings, offline detection
- Production hardening: health checks, structured logging, correlation IDs, circuit breaker, audit trail, data retention policy, security headers

## Features Excluded (v1.0)

- iOS app (architecture + implementation plan only)
- Enterprise/MDM integration (architecture only)
- White Label configuration UI (architecture only)
- Partner Program UI (architecture only)
- Organization Platform / Multi-Tenant (schema + interfaces only, zero rows)
- Push notifications (FCM/APNs — interfaces planned, not implemented)
- Government organization type (explicitly v2)
- Screenshot protection on Parent App (deferred to v1.1)

## Known Limitations

See `docs/release/KNOWN_LIMITATIONS.md` for the full list. Highlights:
- Zero real-device validation performed, on any platform, at any point
- No endpoint-specific rate limit on `/billing/subscribe`
- No offline capability on Parent App beyond connectivity detection + a pending-write queue
- Anti-tamper signals detected on-device but not transmitted to or consumed by the backend
- `LocationEvent` has no defined data retention policy

## Supported Platforms

- **Android**: minimum API level per `AndroidManifest.xml`'s
  `minSdkVersion` — not independently re-verified this session; confirm
  against the actual manifest before publishing
- **iOS**: not yet supported — planned
- **Web (Admin Dashboard)**: modern evergreen browsers — no explicit
  browser support matrix has been tested

## Minimum Android Version

Not independently confirmed in this session. `build.gradle` was never
generated in this sandboxed environment (`flutter create .` was never
run against either Flutter app) — read the real value from
`apps/child-app/android/app/build.gradle`'s `minSdkVersion` once that
file exists, before publishing.

## Planned iOS Version

No date committed here — `IOS_IMPLEMENTATION_PLAN.md`'s 6-step sequence
has no time estimates attached, since estimating Swift/Xcode work
without ever having run Xcode in this project would be a guess.

## Migration Path to Enterprise / School / Bank

All three follow the same path (`ORGANIZATION_PLATFORM_ARCHITECTURE.md`):
`Organization{type: FAMILY}` rows are backfilled from existing `Family`
rows with matching IDs (never a rename of the live table), after which
School/Company/Bank-specific `Organization` rows use the same,
already-designed schema. No second implementation per organization
type; the RBAC/Policy engines are meant to be built once and used by all four.

## Versioning Policy

- Backend API: `/api/v1` today; breaking changes ship as `/api/v2` alongside it
- Public interfaces: frozen per `RELEASE_ARCHITECTURE_FREEZE.md`, changed only via a v2 ADR
- Mobile apps: not yet versioned for release (no app-store listing exists)
