# Penetration Testing Plan

**CLOSES A REAL GAP** identified in the Master Completeness Audit:
zero external penetration testing plan existed. This is distinct from
`SECURITY_REVIEW.md` (an internal static code review this project's
own engineering already performed — IDOR checks, OWASP API Top 10
pass) — a real penetration test requires an independent third party
attacking a real running deployment, which has not happened and
cannot happen in this sandbox.

## Why an internal review is not a substitute

`SECURITY_REVIEW.md`'s own review is valuable and real, but it is
the same team that built the system reviewing their own code — it
cannot catch blind spots that come from familiarity with the system's
own assumptions. A genuine penetration test needs an adversarial,
independent party with no prior knowledge of this codebase's internal
reasoning.

## Scope (grounded in what actually exists to attack)

| Target | Why it matters |
|---|---|
| Public-facing REST API (`/auth/*`, `/support`, `/organizations/campaigns/redeem`) | Every unauthenticated or lightly-authenticated endpoint is the real attack surface |
| JWT implementation (access + refresh token flow) | Token theft/replay is the highest-value attack against any session-based API |
| Device pairing flow (`/pairing/*`) | Highest-consequence attack surface in this specific product — an attacker who could pair a rogue device to someone else's family would gain access to a child's data |
| Rate limiting bypass attempts | Confirm ThrottlerModule + per-endpoint limits actually hold against a determined attacker rotating IPs/headers |
| InternalAdminGuard (business metrics, support inbox) | Recently added specifically because of a real discovered exposure — worth specific adversarial attention to confirm the fix actually holds |
| Multi-tenant isolation (Organization module) | A member of one Organization must never reach another's data — the newest, least-battle-tested part of this codebase |

## What this plan does NOT include (real, separate decisions)

- Choosing a penetration testing firm/individual — a real
  procurement decision (budget, timeline, NDA) outside engineering
  scope, not made here.
- Mobile app binary analysis (reverse-engineering the Android
  APK/Kotlin native layer for exposed secrets, tamper-resistance) —
  a real, separate specialty from web API pen testing; flagged as
  its own line item, not folded into the API test scope above.
- Actually running any test — requires a real deployed
  environment and an engaged third party; neither exists yet.

## Recommended timing

After the first real device validation and staging deployment,
before any public launch or handling of real payment data — attack
surface should be stable (not mid-development) for a penetration test
to produce meaningful, non-stale findings.
