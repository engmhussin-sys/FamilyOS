# Child Agent — Step 1: Core Architecture

**Location:** `apps/child-app/`
**ADR this implements:** `docs/architecture/child-agent-android-enforcement.md`
(step 1 of the 12-step order from Decision-013's directive).
**Scope:** wiring only. No pairing, no permissions, no enforcement, no
policy sync yet — those are Steps 2–12, each its own reviewed change.

---

## ⚠️ Critical limitation: this could not be compiled or run in this session

This sandbox's network allowlist does not include `pub.dev` or any Flutter
SDK distribution point (see the full list in the environment's network
configuration). Every other module in this project so far (`tsc`, `jest`,
`vite build`) was validated by actually running it — **this one was not**.

What I did instead:
- Manually verified brace/parenthesis balance across every `.dart` file
  (all matched — see the commands in this session's transcript).
- Wrote every file against APIs I have high confidence in from training
  (Riverpod's `Provider`/`ConsumerWidget`, Dio's `Interceptor`/`DioException`,
  `flutter_secure_storage`'s `FlutterSecureStorage` interface,
  `MethodChannel`'s Dart/Kotlin contract).
- Kept the Kotlin side minimal and low-risk specifically because it
  couldn't be verified either.

**Required first step in your real environment, before anything else:**
```bash
cd apps/child-app
flutter create . --platforms=android --org com.aifamilycoach --project-name child_app
# ^ this generates the full standard Gradle/wrapper scaffolding this
#   sandbox could not produce — android/build.gradle, gradle-wrapper.*,
#   android/app/build.gradle, res/ assets, etc. It will NOT overwrite the
#   custom files delivered in this step (MainActivity.kt, AgentChannel.kt,
#   AndroidManifest.xml, everything under lib/) as long as you say no to
#   any overwrite prompts for those specific paths — review the diff
#   before confirming.
flutter pub get
flutter analyze
flutter test
```
Do not proceed to Step 2 until `flutter analyze` is clean and
`flutter test` passes.

---

## 1. What was built

```
lib/
  core/
    config/app_config.dart        — API base URL via --dart-define
    storage/secure_token_storage.dart — Keystore-backed device token storage
    network/
      api_client.dart              — Dio client with refresh-and-retry interceptor
      api_exception.dart
    platform/
      agent_channel.dart            — AgentPlatformChannel port (abstract)
      agent_channel_impl.dart        — MethodChannel implementation
      agent_channel_constants.dart    — shared Dart/Kotlin contract
      agent_capability_not_implemented_exception.dart
    di/providers.dart               — Riverpod wiring (mirrors backend *.module.ts)
  app.dart                          — diagnostic-only screen, no feature UI
  main.dart
android/app/src/main/
  kotlin/.../MainActivity.kt         — registers the channel, 2 real methods, rest -> notImplemented()
  kotlin/.../core/AgentChannel.kt     — Kotlin-side constants mirroring the Dart ones
  AndroidManifest.xml                 — INTERNET only; nothing declared speculatively
test/core/storage/secure_token_storage_test.dart
```

## 2. Architectural choices worth explaining

### Same refresh-and-retry pattern as the Admin Dashboard, deliberately
`ApiClient` mirrors `apps/admin-dashboard/src/shared/lib/httpClient.ts`
almost method-for-method: single-flight refresh coordination, retry-once
semantics, clearing the session on unrecoverable failure. Two different
languages, two different actor types (`USER` on the dashboard, `DEVICE`
here), same shape of problem, same solution — this is intentional
consistency, not coincidence.

### The platform channel is a port, not a direct dependency
`AgentPlatformChannel` (abstract) vs. `MethodChannelAgentPlatform`
(concrete) is the same dependency-inversion instinct as every backend
repository port. Nothing in `app.dart` imports `MethodChannel` directly.
This matters more here than it might on the backend: Steps 4–9 will add
real capabilities (Accessibility state, Usage Access state, Foreground
Service control) behind this same port, and application code written
against the port today won't need to change when those land — only the
implementation grows.

### "Not implemented" is explicit and typed, never a silent fake
`MainActivity.kt`'s `else -> result.notImplemented()` and Dart's
`AgentCapabilityNotImplementedException` exist specifically so that
calling a capability from a future step, today, fails loudly and
specifically — not with a generic crash, and never with a fake success
that would be actively dangerous for a safety-critical feature like
Screen Time enforcement.

### `ApiClient` accepts an injectable `Dio` — done for testability, not speculative
Originally written with `Dio` constructed internally. Refactored during
this step (not left for later) once it became clear the interceptor logic
couldn't be unit-tested at all without this seam — same reasoning as
every backend service depending on an injected repository port instead of
instantiating Prisma directly.

## 3. Known follow-ups

1. **`ApiClient`'s interceptor is not unit-tested yet** — needs a fake
   `HttpClientAdapter` or `http_mock_adapter`, written and verified in a
   real Flutter environment (see the limitation note above). The
   constructor refactor that makes this possible is done; the test itself
   is the follow-up.
2. **No Gradle wrapper / standard Android scaffolding delivered** —
   `flutter create .` must be run first, per §"Critical limitation" above.
3. **iOS is entirely out of scope** for this and every subsequent
   Child Agent step, per the ADR — a separate architecture decision is
   needed before any iOS work starts.

## 4. Next step

Step 2 (Secure Pairing) per Decision-013's order: consume the existing
`POST /auth/devices/pairing/confirm` endpoint, implement the multi-method
pairing support from Decision-012 (QR / invitation link / pairing code /
OTP), and persist the resulting device session via `SecureTokenStorage`.
No enforcement-related code yet — that's Steps 6 and 11.
