# Android release signing and the Play artifact — ABNY / «ابني»

| Document ID | Version | Owner Role | Status | Last Updated |
|---|---|---|---|---|
| ANDROID-RELEASE-SIGNING-001 | 1.0 | Release Manager | `STATIC VERIFIED` — no Flutter SDK, no Android SDK, no keystore, no build | 2026-08-17 |

> **Nothing in this document was built or signed.** There is no Flutter SDK and
> no Android SDK in the authoring environment, and `dl.google.com`,
> `pub.dev`, `storage.googleapis.com` and `services.gradle.org` are all
> blocked. The Gradle logic described here was verified two ways — parsed with
> the real Groovy parser, and its release guard **extracted and executed**
> against ten scenarios per app by `scripts/verify_release_signing.py` — and
> that is the whole of the claim. No APK, no AAB, no keystore and no credential
> exists as a result of this work.

---

## 1. What was broken

`docs/release/STORE_READINESS.md` row 5: *both apps sign release with the debug
key, and the workflow builds `apk` not `aab` — so nothing either of them
produces is uploadable.* Two independent defects that combined into one:

| | Before | After |
|---|---|---|
| Release signing | `signingConfig signingConfigs.debug` in both apps | `signingConfigs.release`, populated only from a gitignored `signing.properties` |
| Missing key | silently fell back to the debug key | the build **stops** with an actionable message |
| CI release artifact | `flutter build apk --release`, `continue-on-error: true` | `flutter build appbundle --release`, blocking |
| Unconfigured release in CI | skipped, run green | not requested → said so in words; requested and unsatisfiable → **red** |
| `versionCode` | fell through to a hardcoded `1` | `pubspec.yaml` `version: 0.1.0+1`, CI overrides with a monotonic run number; a fallback version **fails** a release build |

The debug keystore is machine-local, publicly documented and has a published
password. An artifact signed with it cannot be uploaded, and — worse — if one
ever *were* uploaded, nothing could update it afterwards.

---

## 2. Where the key lives

```
apps/<app>/android/
  signing.properties          ← GITIGNORED. Never committed. Four values.
  signing.properties.example  ← committed template + the keytool command
  *.jks / *.keystore          ← gitignored by pattern
```

`apps/<app>/android/.gitignore` carries `signing.properties`,
`!signing.properties.example`, `*.jks`, `*.keystore`, `*.p12`, `*.pepk`. The
keystore is ignored by **extension** rather than by name, so a developer who
names theirs `abny-upload-2027.jks` is covered as well.

`app/build.gradle` reads nothing else. There is no environment-variable path,
no `-P` password, and no second mechanism — one code path, so there is nothing
for a future edit to prefer.

---

## 3. Generating the upload keystore

Run from `apps/<app>/android/`, with the JDK 17 this project pins:

```bash
keytool -genkeypair -v \
  -keystore abny-parent-upload.jks \
  -alias abny-parent-upload \
  -keyalg RSA -keysize 4096 -validity 10000 \
  -storetype PKCS12
```

`-validity 10000` (~27 years) is not decoration: **Play requires an upload key
valid past 22 October 2033.** A shorter validity is accepted at upload and
becomes a wall later. `-storetype PKCS12` avoids keytool's JKS deprecation
warning on every future use.

Then `cp signing.properties.example signing.properties` and fill in the four
values. Full per-flag reasoning is in that example file, next to the code that
reads it.

**Enrol in Play App Signing** (the default for new apps). Google then holds the
*app* signing key and this keystore is only the *upload* key, which Google can
reset for you. That single choice converts "the app is dead, republish under a
new package name and lose every install, review and rating" into a support
ticket. If you opt out, losing this file is terminal.

---

## 4. Why debug signing is now impossible in a release build — three layers

All three are in `apps/<app>/android/app/build.gradle`.

**L1 — structural.** `buildTypes.release` is assigned `signingConfigs.release`
and the expression `signingConfig signingConfigs.debug` does not exist in
either file. When `signing.properties` is absent, `signingConfigs.release` is
declared but **left unpopulated** — deliberately, so AGP has *no* key rather
than inheriting one. That is what turns L2 into a hard stop instead of a
warning.

**L2 — task-graph guard.** `gradle.taskGraph.whenReady` fires once, after
Gradle has resolved every task it is about to run and before it runs the first
one. If the graph contains `assembleRelease`/`bundleRelease`/`packageRelease`/
`installRelease` **for this project**, the guard requires: the properties file
exists; all four keys are non-empty; the keystore file it names exists; and the
version is not a fallback. Otherwise it throws with instructions. A debug build
schedules none of those tasks and pays nothing — `flutter build apk --debug`
still works from a bare checkout with no key material at all.

**L3 — identity assertion.** In the same guard, the *resolved* release signing
config is compared to the debug one **by identity** (`.is()`), and the keystore
path is checked against the well-known debug keystore names
(`debug.keystore`, `debug.jks`, `~/.android/debug*`). L1 is a convention; L3 is
a check. If someone reinstates the old line, or points `signing.properties` at
`~/.android/debug.keystore` "to make the build work", the release build fails
and names what it found.

### 4.1 The guard was executed, not merely reviewed

`scripts/verify_release_signing.py` lifts the `whenReady` closure **verbatim**
out of each `build.gradle`, stubs the six Gradle objects it touches, and runs it
under the Groovy interpreter inside the local Gradle distribution — ten
scenarios per app, twenty executions, plus 32 static assertions. It runs in the
`preflight` job of `.github/workflows/build-apk.yml`, before any SDK download.

| Scenario | Expected |
|---|---|
| debug build, no key present | proceeds |
| release task in **another** project | not ours to police — proceeds |
| release, no `signing.properties` | **throws** — "UNSIGNABLE RELEASE ARTIFACT" |
| release, incomplete `signing.properties` | **throws** — "INCOMPLETE" |
| release, keystore file absent | **throws** — "does not exist" |
| release resolving to the **debug** config | **throws** (L3) |
| release with **no** signing config | **throws** |
| release pointed at `debug.keystore` | **throws** (L3) |
| release on a fallback `versionCode` | **throws** |
| release fully configured | proceeds, and logs the alias and version it signed with |

The two halves are complementary and neither alone would do: the executed half
proves the guard's logic fires correctly on inputs it is given; the static half
proves the file actually *supplies* those inputs. Reinstating
`signingConfig signingConfigs.debug` was tested by hand and trips **three**
static checks.

**What this does not prove:** that AGP consumes the config correctly, that the
keystore is valid, that the AAB is well-formed, or that Play accepts it. Those
need a real toolchain and a real key.

---

## 5. Versioning — one source, and CI increments the code

`apps/<app>/pubspec.yaml`'s `version: 0.1.0+1` is the **only** place either app
declares a version. `flutter build` copies both halves into
`android/local.properties` as `flutter.versionName` / `flutter.versionCode`,
which is where `app/build.gradle` reads them. `local.properties.example`
documents them as *outputs* and says not to maintain them by hand.

`versionCode` — and only `versionCode` — is overridable, because Play refuses a
`versionCode` it has already accepted, so the number must be monotonic **per
upload**, not per commit. CI exports:

```
ORG_GRADLE_PROJECT_abnyVersionCode = <ABNY_VERSION_CODE_OFFSET> + github.run_number
```

`ORG_GRADLE_PROJECT_<name>` is Gradle's own documented mechanism for setting a
project property from the environment. It was chosen over guessing which `-P`
flags the Flutter tool forwards precisely because it is verifiable from Gradle's
manual and it survives being invoked through `flutter build`, which spawns
Gradle with our environment.

- `github.run_number` increments by one per run of this workflow and starts at 1.
- **Not** `github.run_id`: that already exceeds Play's `versionCode` ceiling of
  2,100,000,000. Using it would work once and then be rejected forever — the
  same class of one-way mistake as losing the signing key.
- If the repository is ever re-created, or the workflow renamed and
  `run_number` restarts, set the repository variable
  `ABNY_VERSION_CODE_OFFSET` above the highest `versionCode` Play has accepted.
  Play's rejection message names that number, so recovery is mechanical.

`versionName` is deliberately **not** overridable: the marketing version
belongs to the commit, not to the run that happened to build it.

---

## 6. `applicationId` — unchanged, and still a HUMAN DECISION

| App | `applicationId` |
|---|---|
| parent | `com.aifamilycoach.parent_app` |
| child | `com.aifamilycoach.child_app` |

**Nothing was renamed.** These are immutable after the first Play upload, they
determine which `google-services.json` is valid, which determines whether push
notifications work at all — and `PROJECT_STATUS.md §0`'s `EBNEY` vs `ABNY`
question is still open, as is whether `aifamilycoach` is the intended
organisation prefix for a product called «ابني». **Settle the package names
before the first upload, not after.** See `docs/release/IOS_READINESS.md §3`,
where the same decision is tracked jointly with the iOS Bundle ID.

---

## 7. Building

```bash
# What Play accepts
flutter build appbundle --release \
  --dart-define=API_BASE_URL=https://<host>/api/v1
#   -> build/app/outputs/bundle/release/app-release.aab

# Sideloadable copy for QA on physical devices — same key, same defines
flutter build apk --release \
  --dart-define=API_BASE_URL=https://<host>/api/v1
#   -> build/app/outputs/flutter-apk/app-release.apk

# No key needed, still installable
flutter build apk --debug \
  --dart-define=API_BASE_URL=http://10.0.2.2:3000/api/v1
```

`--dart-define=API_BASE_URL` is mandatory on every build (MA-004) and
`scripts/verify_network_security.py` now enforces it for `appbundle` as well as
`apk`. Release mode additionally requires **https**: `AppConfig` throws
`StateError` at startup otherwise, so a release artifact without it is a
crash-on-launch.

---

## 8. CI

`.github/workflows/build-apk.yml`. The release path is **opt-in** and, once
opted in, **blocking** — the two failure modes it had to avoid pull in opposite
directions:

- attempting a release on every push would be red on every push until someone
  creates a Play account and four secrets, and a permanently red pipeline is a
  pipeline nobody reads;
- a release that quietly does not happen when its secrets are missing is the
  false green this file exists to eliminate.

So the **operator** asks for a release (`release_build=true` on
`workflow_dispatch`, or the repository variable `ABNY_RELEASE_BUILD=true`), and
when they do, every precondition is asserted and any missing one turns the job
red. There is no configuration under which a *requested* release silently does
not happen. `${AAB:-1}` in the Verdict step is deliberate: if the build step
never ran at all, the missing output reads as failure, not success.

### 8.1 Required secrets and variables

| Name | Kind | Required for | Notes |
|---|---|---|---|
| `ANDROID_KEYSTORE_BASE64_PARENT` / `_CHILD` | secret | release | `base64 -w0 <keystore>.jks` |
| `ANDROID_KEYSTORE_PASSWORD_PARENT` / `_CHILD` | secret | release | the `-storepass` |
| `ANDROID_KEY_ALIAS_PARENT` / `_CHILD` | secret | release | the `-alias` |
| `ANDROID_KEY_PASSWORD_PARENT` / `_CHILD` | secret | release | the `-keypass` |
| `GOOGLE_SERVICES_JSON` | secret | parent release (hard), parent debug (soft) | absent → debug builds without FCM and says so; a parent **release** without it is **refused** |
| `RELEASE_API_BASE_URL` | variable | release | must be `https://` |
| `DEV_API_BASE_URL` | variable | optional | defaults to `http://10.0.2.2:3000/api/v1` |
| `ABNY_RELEASE_BUILD` | variable | optional | `true` opts every push into the release path |
| `ABNY_VERSION_CODE_OFFSET` | variable | optional | added to `github.run_number` |

Secrets are **per app** because the two apps are two Play listings with two
`applicationId`s. Sharing one upload key across both is legal and couples the
two releases forever.

The job writes `android/signing.properties` and `android/abny-ci-upload.jks`
from those secrets (with `umask 077`), and a `Shred the signing material` step
with `if: always()` removes both — correct on a self-hosted runner, not only on
an ephemeral hosted one.

---

## 9. What remains BLOCKED

| Item | Why | Consequence |
|---|---|---|
| An actual AAB | no Flutter SDK, no Android SDK, blocked downloads | **the very first `flutter build appbundle` is still unrun.** Given a keystore and a working toolchain the configuration is complete; that it *works* is unmeasured |
| A keystore | must be generated by whoever owns the release, on a machine they control | none was fabricated |
| Play Console account, upload, review | external, needs a legal entity and the store listing | `STORE_READINESS.md` tracks the other 21 MISSING rows |
| Package-name decision | HUMAN DECISION, §6 | immutable after first upload |
| R8 / minification | untouched | `minifyEnabled` is off; enabling it without a Flutter-aware keep-rule set is a separate, testable change and was **not** bundled into a commit that cannot be built |
| `pubspec.lock` | `pub.dev` blocked | release and debug of the same commit can still resolve different plugin versions (audit PA-M-016). The workflow uploads the lockfile it resolved — commit it |
