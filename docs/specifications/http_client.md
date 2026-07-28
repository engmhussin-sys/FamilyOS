# Specification — Authenticated HTTP Client Contract

**Implemented by:**
- `apps/admin-dashboard/src/shared/lib/httpClient.ts` (actor type: `USER`)
- `apps/child-app/lib/core/network/api_client.dart` (actor type: `DEVICE`)

**Purpose of this document:** both implementations independently solve the
same problem (call our backend, attach a bearer token, recover from an
expired access token) in two different languages. Without a written
contract, the two will drift apart silently over a year of independent
small edits — this file is what a future change is checked against,
in either codebase.

Backend contract this depends on:
`apps/backend/src/modules/auth/application/services/token.service.ts`
(`issueTokenPair`, `verifyAndConsumeRefreshToken`).

---

## 1. Required behavior (both implementations MUST do this)

1. **Attach the access token** as `Authorization: Bearer <token>` on every
   request, unless the request is explicitly marked to skip auth (used
   only for the login/register/refresh/pairing-confirm calls themselves).
2. **On a 401 response:**
   a. Attempt exactly **one** token refresh via `POST /auth/refresh`.
   b. **Single-flight guarantee:** if multiple requests hit a 401
      concurrently, they must share the same in-flight refresh call, not
      trigger one refresh per failed request. Both current
      implementations do this via a memoized/shared in-flight promise
      (TS) or `Future` (Dart) — this is not optional; without it, a burst
      of concurrent 401s would race multiple refresh calls against a
      refresh token that rotates on each use (per `TokenService`'s
      rotation design), and all but one would fail.
   c. On successful refresh: retry the **original** failed request once,
      with the new access token. Do not retry more than once per request.
   d. On refresh failure: clear the locally stored session and surface
      the failure to the caller — do not silently swallow it.
3. **Never retry a request that already carries `skipAuth`** — a failed
   login attempt must not trigger a "refresh" cycle.
4. **Never log or expose the refresh token** in error messages, crash
   reports, or console/log output in either implementation.

## 2. Deliberate, documented differences (NOT drift — do not "fix" these to match each other)

| Aspect | Dashboard (`httpClient.ts`) | Child Agent (`api_client.dart`) | Why they differ |
|---|---|---|---|
| Access token storage | Memory only, never persisted | Encrypted Keystore storage (`SecureTokenStorage`) | Dashboard's threat model is XSS in a browser tab; the Agent has no browser/XSS surface, so persistence is safe there and necessary (a native app needs to survive process restarts) |
| Refresh token storage | `sessionStorage` (documented mitigation, see `docs/architecture/admin-dashboard.md` §3) | Encrypted Keystore storage | Same reasoning as above |
| Actor type in issued tokens | `USER` | `DEVICE` | Different auth subjects entirely — see `auth.types.ts`'s `ActorType` |
| Session-expiry signal | A `CustomEvent` (`SESSION_EXPIRED_EVENT`) dispatched on `window`, decoupling `httpClient.ts` from any UI framework | (Step 2+) an `AgentEvent` on the Child Agent's own Event Bus (`docs/architecture/child-agent-plugin-architecture.md`) | Different runtime, same underlying idea: the transport layer never imports the UI/state layer directly |

## 3. Error shape both implementations parse identically

The backend's `HttpExceptionFilter` (implicit NestJS default) returns:
```json
{ "statusCode": 401, "message": "Invalid or expired token.", "error": "Unauthorized" }
```
Both clients must handle `message` being either a `string` (typical) or a
`string[]` (class-validator's default shape for multi-error DTO
validation failures) — joining an array into a single display string.
`httpClient.ts` does this in its `rawRequest` catch block;
`api_client.dart` does the equivalent in `_toApiException`.

## 4. Change process

A change to this contract (e.g. adding a new required header, changing
the retry count) must update **this file first**, then both
implementations in the same change, then note the update in both
modules' architecture docs' "Known follow-ups" or changelog section. A
PR that changes one implementation's retry/refresh behavior without
touching this file and the other implementation should be treated as
introducing drift, not a valid isolated change — per Definition of
Done §5 (API Updated).
