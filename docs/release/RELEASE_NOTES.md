# Release Notes — FamilyOS v1.0 Release Candidate 1

## What's included

**Backend (NestJS)**: Auth, Children, Screen Time, Pairing (Trust/Risk
state machine), Runtime Recovery, Internal AI Platform (7 engines:
Knowledge/Memory/Rule/Decision/Safety/Recommendation/Behavioral),
Notifications, Billing (6 provider adapters), Feature Flags, Profile,
Settings, Reports, Search, Analytics, Health Checks, Audit, System
Diagnostics, Data Retention Policy. **243/243 unit tests, `tsc` clean,
DI graph clean.**

**Admin Dashboard (React)**: full parent-facing web UI — family/children
management, device pairing & status, screen time policy, runtime
timeline, notification center, family insights (AI explainability UI),
reports with CSV export, global search, settings (profile/family/billing
tabs), full Arabic/English localization with RTL support. **28/28
tests, build clean.**

**Child Agent (Flutter/Kotlin, Android)**: pairing, heartbeat with
offline queue, local policy cache, `AccessibilityService`-based
enforcement, permission management, runtime diagnostics UI, recovery
coordinator. **Code-reviewed and unit-tested; not yet validated on a
physical device.**

## Architecture decisions locked this cycle

- **AI Core Independence**: verified via codebase-wide audit — no
  security/policy/trust/risk decision depends on an LLM.
- **Organization Platform**: additive schema + interfaces for future
  Multi-Tenant support, zero implementation, zero impact on existing
  code (243/243 tests unchanged before/after).
- **Release Architecture Freeze**: no new NestJS modules going forward.

## Critical fix this cycle

Admin Dashboard was calling a deprecated pairing endpoint with no
shared state with the real Child App — every pairing code a parent
generated was unredeemable. Fixed.

## Explicitly not included in v1.0

iOS app, Enterprise/MDM integration, White Label configuration UI,
Partner Program UI, Government organization type. See
`KNOWN_LIMITATIONS.md`.

## Versioning

All APIs are served under `/api/v1`. No breaking change will be made to
this prefix — a future incompatible change ships as `/api/v2` alongside it.
