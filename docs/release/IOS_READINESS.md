# iOS readiness — ABNY / «ابني»

| Document ID | Version | Owner Role | Status | Last Updated |
|---|---|---|---|---|
| IOS-READINESS-001 | 1.0 | Release Manager | `STATIC VERIFIED` — no `ios/` directory exists, no Flutter SDK, no macOS, no Apple account, nothing was generated or signed | 2026-08-17 |

> **There is no `ios/` directory in either app.** Not incomplete — **absent**.
> No `Runner.xcodeproj`, no `Info.plist`, no `Podfile`, no entitlements file, no
> asset catalogue. This document exists so that the cost of iOS is decided
> before it is paid, and its single most important section is **§6**, which says
> plainly which parts of the child app **cannot exist on iOS at all**.
>
> **Nothing here was executed.** No `flutter create`, no `xcodebuild`, no
> certificate, no provisioning profile, no App Store Connect record. No Apple
> credential is invented anywhere in this file. `STORE_READINESS.md` already
> records the same fact from the Play side; this document is the iOS half.

---

## 1. Regenerating the iOS platform folder — the exact command

On a **real macOS machine** with Xcode and the pinned Flutter 3.24.5
(`scripts/setup-windows-dev.ps1` documents where that pin comes from; the macOS
equivalent has not been written), run **from the app directory**:

```bash
cd apps/parent-app      # then repeat for apps/child-app
flutter create --platforms=ios --org com.aifamilycoach --project-name parent_app .
```

For the child app the last two arguments become
`--org com.aifamilycoach --project-name child_app`.

### 1.1 What it WILL do

- Create `ios/` with `Runner.xcodeproj`, `Runner/Info.plist`,
  `Runner/AppDelegate.swift`, `Runner/Assets.xcassets`,
  `Runner/Base.lproj/LaunchScreen.storyboard`, `Podfile`,
  `Flutter/{Debug,Release,Generated}.xcconfig`.
- Set `PRODUCT_BUNDLE_IDENTIFIER` to `com.aifamilycoach.parentApp` /
  `com.aifamilycoach.childApp` — **note the camelCase.** `flutter create`
  derives the bundle identifier from `--org` plus the *project name with
  underscores removed and camel-cased*, because a CFBundleIdentifier may not
  contain underscores. **This does not match the Android `applicationId`**
  (`com.aifamilycoach.parent_app`). See §3: that mismatch is a decision, not an
  accident, and it must be made deliberately.
- Leave every existing Dart file, `pubspec.yaml`, `test/`, and the whole
  `android/` tree untouched.

### 1.2 What it will NOT do, and what it will NOT preserve

| | |
|---|---|
| **Will not** touch `lib/`, `test/`, `pubspec.yaml`, `analysis_options.yaml`, `android/` | `flutter create` on an existing project adds the missing platform and re-runs its templates; it does not rewrite Dart |
| **Will not** create any Apple identity | no certificate, no provisioning profile, no App Store Connect app record. Those are account operations |
| **Will not** port a single line of the Kotlin enforcement layer | 20 Kotlin files, zero Swift equivalents. §6 |
| **Will not** register plugin platform code | `pod install` (run automatically by `flutter build ios`) resolves the iOS side of every plugin in `pubspec.yaml`. **A plugin with no iOS implementation fails there**, and this project has never resolved dependencies at all (`pub.dev` blocked, no `pubspec.lock` committed) |
| **WILL OVERWRITE if re-run later** | this is the trap. Once `ios/` exists and has been *edited* — entitlements, capabilities, `Info.plist` usage strings, signing team, App Groups — re-running `flutter create --platforms=ios .` **restores template versions of the files it owns**. `Runner.xcodeproj`, `AppDelegate.swift`, `Info.plist`, `Podfile` and the `.xcconfig` files are all template-owned |

**Therefore: run it exactly once per app, commit `ios/` immediately and
unmodified in that first commit, and only then start editing.** That way the
diff between "what Flutter generated" and "what we changed" is readable forever,
and an accidental re-run is a `git checkout` rather than an archaeology project.
The same discipline is why `android/` is committed in this repository — Sprint
17.2's root-cause finding was that it had *never* been committed, wrapper
included.

---

## 2. Prerequisites — Apple Developer Program and App Store Connect

Nothing in this list can be created from a Linux CI runner, and none of it has
been started.

| # | Prerequisite | Notes / lead time |
|---|---|---|
| 1 | **Apple Developer Program membership** | **US$99/year, per organisation.** An *Organisation* membership (not Individual) requires a **D-U-N-S number** for the legal entity. Obtaining a D-U-N-S is free but commonly takes **1–2 weeks**, and Apple then verifies the entity. This is the long pole and it should start in week 1, in parallel — the same lesson `PHASE-D-Payments-Report.md` §9 records about merchant onboarding |
| 2 | **A Mac** | Xcode runs on macOS only. Options: a physical Mac, or a hosted macOS CI runner (GitHub's `macos-*` runners, or a service such as MacStadium). There is no supported cross-compilation path |
| 3 | **Xcode**, matching the Flutter pin | Flutter 3.24.5's supported Xcode range must be confirmed on the machine — **not from memory.** `flutter doctor -v` is the authority |
| 4 | **Bundle IDs registered** in the Developer portal | Two of them (parent, child). Immutable in practice — see §3 |
| 5 | **Signing identity** | Apple Distribution certificate + App Store provisioning profile per bundle ID. Xcode's *Automatically manage signing* handles it for local builds; CI needs the `.p12` and the profile as secrets, exactly as Android needs the keystore |
| 6 | **App Store Connect app records** | Two. Each needs the bundle ID, a primary language, a category, and an **age rating questionnaire** |
| 7 | **App Privacy ("privacy nutrition label")** | Apple's own form, **and** `PrivacyInfo.xcprivacy` privacy-manifest files — required for the app and for third-party SDKs on Apple's "commonly used SDK" list, which includes **Firebase**. `STORE_READINESS.md` §8 already establishes the data inventory is **wider than nine fields**: parent name/email/password, a **minor's date of birth**, device identifiers from pairing, battery and permission state from the heartbeat, tamper signals, and Sentry logs. All of it must be declared |
| 8 | **Sign in with Apple** | **Required** if the app offers any third-party social login. Check the parent app's auth surface before assuming this is not needed |
| 9 | **Account Deletion** | Apple requires in-app account deletion **and** a web link, the same as Play since 2023. `STORE_READINESS.md` records the in-app path exists and the **web link does not** — one gap, two stores |
| 10 | **Paid Applications Agreement** signed, plus banking and tax forms | **Blocks all StoreKit purchases, including sandbox.** Without it, §5's product configuration cannot even be tested |
| 11 | **Export compliance** | The app uses HTTPS/TLS only. Usually satisfied by `ITSAppUsesNonExemptEncryption = false` in `Info.plist`, but that is a **legal declaration**, not a technical one — `HUMAN DECISION` |
| 12 | **TestFlight** for review-adjacent testing | Internal testers need no review; external testers do |

---

## 3. `HUMAN DECISION REQUIRED` — the Bundle ID, jointly with the Android package name

This is the **same decision** as `STORE_READINESS.md` rows 1.1 and 1.2, not a
new one, and it must be answered once for all four identifiers.

| Identifier | Today | Mutable after first publish? |
|---|---|---|
| Android `applicationId` (parent) | `com.aifamilycoach.parent_app` | **No** |
| Android `applicationId` (child) | `com.aifamilycoach.child_app` | **No** |
| iOS Bundle ID (parent) | **does not exist**; `flutter create` would produce `com.aifamilycoach.parentApp` | **No, in practice** |
| iOS Bundle ID (child) | **does not exist**; would produce `com.aifamilycoach.childApp` | **No, in practice** |

Three things collide here and all three are open:

1. **The brand is «ابني» / ABNY, and the reverse-domain prefix says
   `aifamilycoach`.** `PROJECT_STATUS.md §0`'s `EBNEY` vs `ABNY` question is
   still unresolved. **Nothing has been renamed in this work** and nothing
   should be renamed casually: the Android `applicationId` also selects which
   `google-services.json` is valid, which decides whether push notifications
   work at all (`docs/release/FIREBASE_SETUP.md`).
2. **iOS cannot use the Android form.** `parent_app` contains an underscore;
   CFBundleIdentifier is restricted to alphanumerics, hyphen and period. So the
   two platforms' identifiers will differ *somehow*. The choices are: accept
   `com.aifamilycoach.parentApp`, or normalise both platforms to a
   hyphenated/dotted form (`com.abny.parent`, `com.abny.child`) — which for
   Android means **choosing it before the first Play upload**, because
   afterwards it is a different app with zero installs, reviews and ratings.
3. **The child app is a monitoring agent.** A bundle ID and display name that
   read as parental control invite a stricter review on both stores. Whether to
   name it plainly (honest, and Apple's *Screen Time / parental control* review
   path expects it) or neutrally (softer to a child, and looks like concealment
   to a reviewer) is a **product** decision with a compliance consequence.

**Recommendation, offered as input and not as a decision:** settle all four
identifiers in one meeting, **before** the first upload to either store, and
prefer a single brand-aligned prefix over inheriting `aifamilycoach` by
accident. The cost of deciding is one meeting; the cost of not deciding is
either two mismatched brands forever, or discarding an app's entire install base.

---

## 4. `HUMAN DECISION REQUIRED` — is there an iOS product at all?

Read §6 first, then answer this. It is listed *before* the StoreKit section on
purpose: the money question is downstream of the capability question.

| Option | What ships | Cost | Honest downside |
|---|---|---|---|
| **A. Android only** (today's implicit plan) | two Android apps | already sunk | no iOS families. In Egypt and Saudi Arabia Android's share is the majority, so this is defensible — **but the parent is the paying customer and iPhone skews toward payers** |
| **B. Parent app on iOS, child app Android-only** | iOS parent app: dashboards, alerts, rewards, subscription, chat. Child agent stays Android | one platform folder, StoreKit, ~all of §2 | **the honest one.** A parent on iPhone supervising an Android child device is a completely coherent product, and the parent app needs none of the capabilities §6 says do not exist |
| **C. Both apps on iOS** | as B, plus an iOS child app | **B + a reimplementation the platform does not permit** | §6. The result would be a differently-shaped, weaker product wearing the same name — and *that* is the expensive false assumption this document exists to prevent |
| **D. iOS child app via Apple's own frameworks** | a genuinely different product built on `FamilyControls` / `ManagedSettings` / `DeviceActivity` | a separate project | Apple's Screen Time API can restrict apps and report activity **without** our server ever seeing which apps — a real capability, but its data never reaches our backend in the shape ABNY's rewards engine consumes. It is not a port; it is a second product |

**Option B is the only one that does not require a promise the platform cannot
keep.** No decision is made here.

---

## 5. StoreKit 2 product configuration — matching what the backend already expects

The backend's Apple path is **built and tested** (`PHASE-D-Payments-Report.md`
§5): `AppleStoreKitProvider`, a JWS ES256 verifier with the `x5c` chain pinned
to Apple Root CA G3, and the App Store Server API client. What is missing is
Apple-side configuration and credentials. **Nothing below was created.**

### 5.1 What the server requires from the store, field by field

| Server expectation | Where in the code | What must be true in App Store Connect |
|---|---|---|
| `bundleId` matches ours | `apple-storekit.provider.ts`, step 2 | `APPLE_BUNDLE_ID` env var equals the real bundle ID. A genuine receipt for **another developer's app** is otherwise indistinguishable, and there is a test for exactly that |
| `productId` maps to one of **our** tiers | `PricingService.resolveByStoreProduct` → `subscription_prices.store_product_id` | Each auto-renewable subscription's **Product ID** must equal a `store_product_id` row. Unmapped product → **rejected**, grants nothing. There is no default |
| price and currency match our catalogue | `PricingService.assertAmountMatches`, tolerance 1 minor unit | Apple's price tier per storefront must correspond to the `subscription_prices` row for that country. A mismatch is a **rejection**, not a warning |
| `appAccountToken` present | `resolveTenant` → `provider_account_links` | **The client MUST set `appAccountToken` to our opaque family reference on every purchase.** This is the cross-tenant defence: without it the server falls back to the session *with a logged warning*, which is a weaker binding and a real risk |
| `environment` distinguishes Sandbox | step 5 | A sandbox receipt presented to production is **refused** and recorded |
| Server Notifications V2 | `PaymentWebhookService` | The **V2** URL must be set in App Store Connect (production **and** sandbox). V1 is a different, unsupported shape |
| `APPLE_ROOT_CA_G3_FINGERPRINT` set | `apple-jws.verifier.ts` | **No default, deliberately.** Unset → every signature refused, loudly. A fingerprint typed from memory would fail closed in production for an undiagnosable reason and then be deleted. `apps/backend/.env.example` carries the `openssl` command that derives it |

### 5.2 The products to create

Auto-renewable subscriptions in **one subscription group** (so upgrade/downgrade
and proration work; Apple only prorates within a group), one product per tier ×
billing period, with Product IDs matching `subscription_prices.store_product_id`
exactly. **The tiers and prices themselves are `HUMAN DECISION REQUIRED #1` and
`#3` in `PHASE-D-Payments-Report.md` §8 and are deliberately unseeded** —
migration `0014` plants countries and VAT rates and **not one price**, with a
test asserting the table is empty so that nobody adds a "temporary" price
without arguing for it.

### 5.3 Credentials still needed (`BLOCKED`)

Issuer ID, Key ID, and the `.p8` In-App Purchase key from App Store Connect →
`APPLE_ISSUER_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY`, plus `APPLE_BUNDLE_ID`
and `APPLE_ROOT_CA_G3_FINGERPRINT`. **All five are absent and none was
fabricated.** The verifier's algorithm is proven against a real three-link
ECDSA chain generated by openssl in `test/billing/apple-chain.fixture.ts`; what
is untested is interoperability with **Apple's actual key material**.

### 5.4 The 30% question is the same question as Play

`HUMAN DECISION REQUIRED #2` (store billing 15–30% vs direct checkout 2–3%,
~US$336K/year) applies identically to Apple, with one difference that matters:
Apple's anti-steering rules are **stricter** than Play's, and — unlike Google
Play — **StoreKit is the only mechanism for digital subscriptions inside an iOS
app.** Fawry and mobile wallets, which are a large share of the Egyptian market,
**cannot be reached through StoreKit at all**. If the business chooses direct
checkout for Egypt, the iOS app either does not sell there or sells at a
different price. **That is a pricing decision, not an engineering one**, and it
should be made before, not after, the iOS folder exists.

---

## 6. The honest capability table — what has NO iOS equivalent

**This is the section that prevents the expensive false assumption.** The child
app's enforcement layer is 20 Kotlin files resting on four Android primitives.
Verified by reading the source, not assumed:

| Android capability | Where it is used here | What it does for ABNY | iOS equivalent | Honest verdict |
|---|---|---|---|---|
| **`AccessibilityService`** (`ChildGuardAccessibilityService.kt`) | receives a system callback on **every foreground app change**, resolves the package, evaluates blocked-package / bedtime / daily-limit rules, and calls `goHome()` | **the entire enforcement trigger** | **NONE.** iOS has no public API through which a third-party app is told what the user just opened, and no API to send another app to the background | **IMPOSSIBLE** |
| **`UsageStatsManager`** (`DailyUsageTracker.kt`, `SessionAnalyzer.kt`) | `queryUsageStats(INTERVAL_DAILY, …)` per package → real per-app time, which the daily-limit rule and the whole analytics/reward pipeline consume | **the data the product is built on** | **NONE that we can read.** `DeviceActivity` (Screen Time) reports activity **inside Apple's own extension sandbox**, which cannot make network calls or hand app-level data to the containing app. Apple's design intent is that not even the developer sees it | **IMPOSSIBLE as designed.** Not "harder" — the data cannot reach our backend |
| **`SYSTEM_ALERT_WINDOW` / `TYPE_APPLICATION_OVERLAY`** (`OverlayManager.kt`) | draws the full-screen blocking view over whatever app is open | **the visible act of enforcement** | **NONE.** An iOS app cannot draw over another app. `ManagedSettings` can make an app *unlaunchable* with Apple's own shield UI — different mechanism, different look, and **not ours to customise** | **IMPOSSIBLE as built; partially replaceable by a system-owned shield** |
| **`RECEIVE_BOOT_COMPLETED` + foreground service + `WorkManager`** (`BootReceiver.kt`, `ChildGuardForegroundService.kt`, `RuntimeWatchdogWorker.kt`) | keeps the agent alive across reboot and screen-off; the persistent notification is what makes it survive | **the agent existing at all** | **NONE.** iOS has no boot receiver, no persistent foreground service and no arbitrary background execution. Background work is opportunistic and OS-scheduled | **IMPOSSIBLE** |
| **OEM autostart deep links** (`OemBackgroundRestrictionManager.kt`, 11 declared vendor packages) | walks the child through Xiaomi/Oppo/Vivo/Huawei/Samsung/Transsion autostart allow-lists | keeps the agent alive on skinned Android | **N/A** — iOS has one vendor | **not needed** |
| **`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`** (`PermissionManager.kt`) | asks for the Doze exemption that keeps the agent alive overnight | agent longevity | **NONE**, and not applicable | **IMPOSSIBLE / moot** |
| **`AntiTamperDetector`** (root, mock location, emulator, developer mode, USB debugging) | reports tamper signals to the backend | detecting a child disabling supervision | **partial.** Jailbreak heuristics exist but are fragile and Apple discourages them. `DeviceCheck`/`App Attest` prove *app integrity*, not device posture | **WEAKER** |
| **Preventing uninstall** | not implemented on Android either (needs Device Owner / MDM) | — | on iOS, **Screen Time restrictions can block app deletion** when the device is supervised or the Screen Time passcode is parent-held | **iOS is actually STRONGER here** — the one row that goes the other way |
| **`FamilyControls` / `ManagedSettings` / `DeviceActivity`** | not used; Android has no analogue | — | **iOS-only.** Requires a **special Apple entitlement, granted by request**, plus a parent-authorised `AuthorizationCenter` flow. Can shield apps and categories, set time windows, and report activity **privately** | **the only real iOS path — and it produces a different product** |

### 6.1 What the iOS product would therefore be

- **The parent app ports cleanly.** It is a Flutter app that talks to our REST
  API: dashboards, the `_NeedsYouCard` queues, children's status, rewards
  approval, chat, subscription. Nothing in §6 is required for any of it. This is
  Option B and it is genuinely achievable.
- **The child app does not port.** An iOS "child app" built on
  `FamilyControls` would: shield apps chosen by the parent, enforce schedules,
  and block deletion of itself — **but it would not report which apps were used
  for how long to our backend**, so the reward engine, the analytics, the
  behavioural trend features and the "هل ابني بخير اليوم؟" risk signal all lose
  their input. Same brand, materially different promise.
- **Do not describe iOS supervision as parity.** If iOS ships as Option B, say
  so in the store listing and in the marketing: *supervision requires an Android
  device; the parent app runs on both.* A parent who buys a subscription on
  iPhone expecting to supervise an iPhone will refund and leave a one-star
  review, and they will be right to.

### 6.2 Entitlements the child app would need (Option D only)

None of these can be requested without §2 item 1 in place.

| Entitlement / capability | Why | Notes |
|---|---|---|
| `com.apple.developer.family-controls` | `FamilyControls`, `ManagedSettings`, `DeviceActivity` | **Requires an Apple approval request with a written justification.** Approval is not automatic and is the schedule risk |
| App Group (`group.<bundle-prefix>.…`) | the `DeviceActivityMonitor` extension and the app share state | the extension **cannot** make network calls; the App Group is the only channel |
| `DeviceActivityMonitor` app extension | receives threshold callbacks | a separate build target |
| Push Notifications (`aps-environment`) | parent alerts; FCM on iOS is an APNs wrapper | needs an **APNs key** uploaded to Firebase, separate from the Android setup |
| Background Modes | heartbeat | opportunistic only; **do not design around it** |
| Keychain sharing | token storage | if the extension needs credentials |

---

## 7. Summary — status by row

| # | Item | Status |
|---|---|---|
| 1 | `ios/` platform folder (either app) | **MISSING** — one command per app, on macOS |
| 2 | Apple Developer Program membership | **MISSING** — D-U-N-S, 1–2 weeks+, **start first** |
| 3 | Mac / macOS CI runner | **MISSING** |
| 4 | Bundle IDs | **HUMAN DECISION** (§3, joint with the Android package names) |
| 5 | Is there an iOS product, and which one | **HUMAN DECISION** (§4 — read §6 first) |
| 6 | Signing identity (certificate + profile) | **MISSING / BLOCKED** — none fabricated |
| 7 | App Store Connect records ×2 | **MISSING** |
| 8 | App Privacy answers + `PrivacyInfo.xcprivacy` | **MISSING** — the inventory is wider than nine fields |
| 9 | Paid Applications Agreement + banking/tax | **MISSING** — blocks **all** StoreKit, sandbox included |
| 10 | StoreKit subscription products | **MISSING**; prices are `HUMAN DECISION #1`/`#3` |
| 11 | Apple credentials (`.p8`, Issuer ID, Key ID, bundle ID, root fingerprint) | **BLOCKED** — server code is built and tested; none invented |
| 12 | `appAccountToken` set by the iOS client on purchase | **MISSING** — required by `resolveTenant`; without it tenancy binds only to the session |
| 13 | Server Notifications **V2** URL configured | **MISSING** |
| 14 | Account deletion **web** link | **MISSING** — same gap as Play |
| 15 | Sign in with Apple | **HUMAN DECISION** — required if any social login exists |
| 16 | Export compliance declaration | **HUMAN DECISION** — a legal statement |
| 17 | iOS enforcement layer (child app) | **IMPOSSIBLE as built** — §6 |
| 18 | `com.apple.developer.family-controls` entitlement | **MISSING**, and approval-gated (Option D only) |
| 19 | Apple sandbox verification against real Apple servers | **BLOCKED** — `PHASE-D-Payments-Report.md` §9 |
| 20 | iOS CI | **MISSING** — needs a macOS runner; `.github/workflows/build-apk.yml` is Android-only by design |

---

## Assumptions and open risks

1. **Nothing here was executed and nothing was generated.** No `flutter create`,
   no Xcode, no macOS, no Apple account. Every command is written to be run by
   someone who has those things, and every claim about what `flutter create`
   produces is from its documented behaviour, **not** from having run it in this
   environment.
2. **Apple's rules and API surface change.** The network is blocked here, so no
   Apple documentation page was fetched in this session; this document reflects
   Apple's platform and policy as known to its author's cutoff. `FamilyControls`
   in particular has gained capability every year. **Re-verify §6 against live
   documentation before committing to Option C or D** — it is the section most
   likely to have moved, and the section with the most money resting on it.
3. **§6 is the load-bearing section and it is a reading of *our* Android
   source**, which is accurate, plus a claim about the *absence* of iOS APIs,
   which is a negative and therefore the weaker half. The strong form —
   "`AccessibilityService`, `UsageStatsManager` and overlays have no third-party
   iOS equivalent, by Apple's deliberate design" — has been stable for years and
   is not a close call. If it is ever wrong, it will be wrong in the direction
   of Apple adding a *private, on-device* capability, which does not change the
   conclusion that **the data cannot reach our backend**.
4. **The Bundle ID decision is coupled to an already-open Android decision**
   (`STORE_READINESS.md` 1.1/1.2, `PROJECT_STATUS.md §0`). Answering it for iOS
   alone would create exactly the split-brand outcome §3 warns about.
5. **Option B's honesty requirement is a product commitment, not a doc note.**
   If iOS ships as parent-only, the store listing, the marketing and the
   onboarding all have to say that supervision needs an Android device. Nothing
   in the codebase enforces that today, and no such copy exists.
6. **No cost estimate is given for Option B.** It would require knowing the
   plugin set resolves on iOS, and this repository has never resolved its
   dependencies at all — no `pubspec.lock`, `pub.dev` blocked. **The first
   `pod install` is an unrun measurement**, in exactly the way the first
   `flutter build apk` still is.
