# Security Review — Release Candidate

## IDOR / Ownership Verification — full endpoint audit

Every controller endpoint accepting `childId`, `deviceId`, or a generic
resource `id` in its path was checked this session for ownership
verification before any read or write. **17/17 clean.**

| Controller | Endpoint(s) | Verifies via |
|---|---|---|
| `ConsentController` | `GET/POST children/:childId/consents` | `ChildrenService.assertChildBelongsToFamily` |
| `DataExportController` | `GET children/:childId/export` | `ChildrenService.getChildOrThrow` |
| `ChildrenController` | `GET/PATCH/DELETE children/:childId` | `ChildrenService.getChildOrThrow` / `assertChildBelongsToFamily` |
| `PairingController` | `GET device/:deviceId/status`, `GET device/:deviceId/timeline` | `PairingOrchestratorService.assertDeviceBelongsToFamily` |
| `AiCoreController` | `GET ai-core/device-health/:deviceId` | `assertDeviceBelongsToFamily` |
| `AiPlatformController` | `GET recommendation/:childId`, `behavioral-trend/:childId`, `decision-history/:childId`, `insights/:childId` | `assertDeviceBelongsToFamily` (device-scoped) / `ChildrenService.getChildOrThrow` (decision-history) |
| `NotificationsController` | `PATCH notifications/:id/read` | Ownership baked directly into the `WHERE` clause (`updateMany({ id, userId })`) — returns `count: 0` rather than a 404 for someone else's notification, deliberately not confirming the ID even exists |
| `ReportsController` | `GET reports/:childId` | `getChildOrThrow` + `assertDeviceBelongsToFamily` |
| `ScreenTimeController` | `GET/POST screen-time/:childId` | `assertChildBelongsToFamily` |

**Historical note, still relevant:** an earlier sprint's device-status
endpoint originally lacked this check and was caught and fixed at the
time — this pattern (verify-before-touch on every ownership-sensitive
endpoint) has been the standing discipline since, and this session's
audit found no regression of it anywhere.

## Critical finding from the previous session, re-verified here

The Admin Dashboard's `pairingApi.ts` was calling a deprecated endpoint
(`/auth/devices/pairing/initiate`) whose Redis key namespace
(`device-pairing:`) never overlapped with the current `PairingModule`'s
namespace (`pairing-invitation:`) that the real Child App reads from —
**confirmed again this session** via direct inspection of both
services' key-prefix constants. Fixed in the previous session; the fix
is still in place.

## OWASP API Security Top 10 — pass-by-pass

| # | Risk | Status |
|---|---|---|
| API1 | Broken Object Level Authorization | ✅ See the IDOR audit above |
| API2 | Broken Authentication | ✅ `JwtAuthGuard` on every non-public controller; `argon2` password hashing; access/refresh token rotation with single-use refresh tokens (`TokenService`) |
| API3 | Broken Object Property Level Authorization | ✅ Global `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })` — a client cannot set fields a DTO doesn't declare |
| API4 | Unrestricted Resource Consumption | ✅ `ThrottlerModule` global (100 req/min) + per-endpoint stricter limits (login, pairing invite/accept, AI recommendation) |
| API5 | Broken Function Level Authorization | ✅ Every mutating endpoint requires `JwtAuthGuard`; no endpoint infers family/child scope from a client-supplied body field instead of the verified JWT |
| API6 | Unrestricted Access to Sensitive Business Flows | ⚠️ **Gap, not fixed this session**: no explicit rate limit exists specifically on `POST /billing/subscribe` beyond the global default — a scripted abuse of the `MANUAL` payment adapter (always succeeds) could generate many `ACTIVE` subscriptions. Flagged for `KNOWN_LIMITATIONS.md`. |
| API7 | Server Side Request Forgery | ✅ N/A — this backend makes exactly one outbound call to a fixed host (`api.anthropic.com` via the SDK); no user-controlled URL is ever fetched server-side |
| API8 | Security Misconfiguration | ✅ Sprint 9: helmet CSP/HSTS, `StartupValidationReport` fails hard on weak/missing secrets, `.dockerignore` excludes `.env`/`node_modules` from the production image |
| API9 | Improper Inventory Management | ✅ Single `/api/v1` prefix, no undocumented/shadow endpoints found during this session's controller enumeration |
| API10 | Unsafe Consumption of APIs | ✅ The one external API call (Anthropic) is wrapped in a Circuit Breaker (Sprint 9) and its response is never trusted for business decisions — see AI Independence below |

## Sensitive logging review

`LoggingInterceptor` (Sprint 9) logs method/path/status/duration/correlationId
only — checked against every controller this session; no controller
method logs its own request body. `GlobalExceptionFilter` never
surfaces a 5xx's real message to the client (tested explicitly,
Sprint 9). `AuditService` records `entityId`/`action`/`metadata` —
metadata payloads checked (login/logout/policy-change/billing) contain
no passwords or tokens.

## Secrets handling

`SecretsValidator` (Sprint 9) fails the process at boot on missing/weak
JWT secrets. `.env` files excluded from Docker build context. No secret
value is ever included in a log line, audit metadata field, or API
error response — checked across `GlobalExceptionFilter`,
`AuditService`, and `SystemDiagnosticsController`'s `configValidation`
field (keys only, never values).

## Token expiration & replay protection

Access tokens are short-lived (`accessTokenExpiresInSeconds`); refresh
tokens are single-use and rotated on every `refresh`/`logout` call
(`TokenService.verifyAndConsumeRefreshToken` — the "consume" is literal,
the token is revoked in the same call that reads it, closing the replay
window).

## Encryption

Passwords: `argon2` (memory-hard, current best practice). Location
data: `LOCATION_ENCRYPTION_KEY`-based encryption already existed prior
to this session (`env.validation.ts`'s original scope) — reviewed, not
changed. Transport: HSTS enforced (Sprint 9); this backend does not
terminate TLS itself in production (expected to sit behind a
load balancer/reverse proxy that does — a deployment configuration
concern, documented in `PRODUCTION_DEPLOYMENT_GUIDE.md`).

## AI Independence — re-verified this session

See `docs/architecture/RELEASE_ARCHITECTURE_FREEZE.md`'s AI Freeze
audit section for the full grep-based verification. Restated here
because it's a security property, not just an architecture one: **no
blocking, safety, risk, trust, or policy decision in this codebase is
computed by an LLM.** The six core AI engines (Rule/Decision/Safety/
Behavioral/Memory/Knowledge) have zero code path touching `AI_PROVIDER`.
The three services that do touch it (`AiCoreOrchestratorService`,
`AiDiagnosticsService`, `RecommendationEngineService`) use it
exclusively for natural-language phrasing of an already-computed
result, with a tested, working deterministic fallback for every one of
them when the provider is unreachable or unconfigured.
