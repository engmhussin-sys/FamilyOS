# Architecture Notes — Auth Module

**Location:** `apps/backend/src/modules/auth/`
**Depends on:** Database schema from `apps/backend/prisma/schema.prisma` (no migration needed — reuses `User`, `Family`, `FamilyMember`, `Device`, `RefreshToken`), `common/prisma`, `common/redis`.

---

## 1. Why this layering

```
domain/         → framework-agnostic types & exceptions (auth.types.ts, auth.errors.ts)
application/     → use-case services (AuthService, TokenService, PasswordService, PairingService)
                    + ports/ (repository interfaces + DI tokens — the inversion boundary)
infrastructure/   → Prisma adapters implementing the ports
presentation/      → controllers, DTOs, Passport strategies, guards
```

`application/` services never import a Prisma type directly for control flow —
they depend on `IUserRepository` / `IRefreshTokenRepository` / `IDeviceRepository`
interfaces, bound to concrete Prisma classes only inside `auth.module.ts`. This
is why `test/auth/*.spec.ts` can unit-test `AuthService`, `TokenService`, and
`PairingService` completely with `jest.fn()` mocks and **no running database**
— the only test that needs a real Postgres instance is
`test/database/schema.spec.ts` from the previous step, which is deliberately
an integration test, not a unit test.

## 2. API surface introduced in this step

All routes are prefixed `/api/v1` (see `main.ts`).

| Method | Path | Auth required | Purpose |
|---|---|---|---|
| POST | `/auth/register` | none (throttled: 5/min) | Create a parent account + their Family (as OWNER) |
| POST | `/auth/login` | none (throttled: 10/min) | Exchange email/password for an access+refresh token pair |
| POST | `/auth/refresh` | none (throttled: 20/min) | Rotate a refresh token for a new pair |
| POST | `/auth/logout` | parent access token | Revoke a specific refresh token |
| POST | `/auth/devices/pairing/initiate` | parent access token | Generate a one-time device pairing code for a child |
| POST | `/auth/devices/pairing/confirm` | none (code is the credential; throttled: 10/min) | Child App redeems a pairing code, receives device-bound tokens |

Every request body is validated by a DTO (`class-validator`) and the global
`ValidationPipe` (`whitelist: true, forbidNonWhitelisted: true`) — unknown
fields are rejected outright, not silently dropped or trusted.

## 3. Security model

- **Two separate JWT secrets** (`JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`),
  validated at boot (`src/config/env.validation.ts`) to be present, distinct,
  and ≥32 characters — the app refuses to start otherwise.
- **Two separate actor types** (`USER` for parents, `DEVICE` for paired child
  devices), enforced both in the JWT payload (`actorType`) and via two
  distinct Passport strategies/guards (`JwtAuthGuard` vs `DeviceJwtAuthGuard`)
  — a stolen device token cannot be replayed against parent-only endpoints.
- **Refresh token rotation**: every `/auth/refresh` call revokes the token
  used and issues a brand-new pair. A refresh token can only ever be
  redeemed once. Reuse of an already-revoked token fails immediately
  (`InvalidOrExpiredTokenException`) — a strong signal of token theft that
  a future module can hook to trigger a security alert.
- **Refresh tokens are stored hashed** (SHA-256) — the `refresh_tokens.token_hash`
  column can never be reversed into a usable token even with full DB read
  access.
- **Passwords are hashed with Argon2id** (OWASP-recommended parameters), never
  compared in plaintext, never logged.
- **Device pairing codes never touch Postgres.** They live in Redis with a
  10-minute TTL and are deleted atomically on first read
  (`RedisService.getAndDelete`) — a leaked database backup can never expose
  a still-valid pairing code.
- **Identical failure behavior for "unknown email" and "wrong password"**
  in `AuthService.login` — prevents user enumeration via the login endpoint.
- **Rate limiting** via `@nestjs/throttler`, tightened specifically on
  `register`, `login`, and `pairing/confirm` — the three endpoints an
  attacker would brute-force.

## 4. Known follow-ups (explicitly, not silently, deferred)

1. **`DevicePairingController.initiate` does not yet verify that `childId`
   belongs to the caller's family.** It trusts `familyId` from the caller's
   own access token, but not that the specific `childId` is actually one of
   *their* children. This closes once the `ChildrenModule` (family-scoped
   child CRUD + a `FamilyGuard`) exists — tracked as the next module to
   build, not silently ignored. Documented in-code with a `NOTE:` comment
   at the top of `device-pairing.controller.ts`.
2. **Email verification flow** (`User.emailVerifiedAt`) is modeled in the
   schema but no endpoint sends/confirms a verification email yet — Phase 1
   follow-up.
3. **MFA** (`User.mfaEnabled` flag exists) — not implemented in this step.
4. **Account lockout after repeated failed logins** — currently relies on
   the global rate limiter only; a dedicated lockout policy (e.g. exponential
   backoff per email) is a good Phase 1 hardening follow-up.

## 5. Environment validation note

`tsc --noEmit` and the full unit test suite (18 tests, 4 suites) were run
and pass in this session. `prisma generate` could **not** be run — the
Prisma engine binary download is blocked by this sandbox's network egress
rules (`binaries.prisma.sh` is not in the allowed domain list) — so
type-checking used a temporary, hand-written stub for `@prisma/client`
types (not part of the deliverables). **Run `npx prisma generate` as your
first command** in a real environment with full network access before
running the backend; the repository implementations
(`infrastructure/repositories/*.ts`) are written directly against the real
Prisma Client API and were validated against the schema field-by-field —
they should work as-is once the client is generated for real.
