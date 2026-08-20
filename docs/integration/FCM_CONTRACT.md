# FCM Integration Contract — ABNY / «ابني»

**Status:** CONTRACT ONLY. G11.
**Audience:** the engineer who owns Firebase Cloud Messaging delivery.
**This document implements nothing.** It defines the seam between the FCM work
stream and this repository, so that both halves can be built independently and
meet without a rewrite.

## 0. Why this document is a contract and not a design

FCM is **delegated**. This repository therefore deliberately does **not**
implement, duplicate, or pre-empt FCM infrastructure. What it does do is
already-built and must not be rebuilt:

- the token registration endpoint **exists**;
- the transport send and its error classification **exist**;
- the delivery queue, its retry/backoff and its state machine **exist**;
- the Smart Notification Engine that decides *whether* to notify **exists**.

Everything below is either **EXISTS** (documented, do not reinvent) or **TO
BUILD** (yours, with the seam pinned down here). Where a real route exists, this
document names the real route; nothing here is an invented endpoint.

## 1. Ownership

| # | Piece | Owner | State |
|---|---|---|---|
| 1 | Firebase project, Android apps for both package IDs | **FCM engineer** | TO BUILD — needs a real external account |
| 2 | `google-services.json` for each app | **FCM engineer** | TO BUILD — absent; `release-doctor.sh` reports it BLOCKED |
| 3 | `apps/parent-app/lib/firebase_options.dart` (`flutterfire configure`) | **FCM engineer** | TO BUILD — absent |
| 4 | `FIREBASE_SERVICE_ACCOUNT_JSON` env var in each backend environment | **FCM engineer / ops** | TO BUILD — unset; every send is a documented no-op until then |
| 5 | Client token acquisition + refresh listener | **this repo** | EXISTS — `PushRegistrationService` |
| 6 | `POST /api/v1/pairing/parent-device/push-token` | **this repo** | EXISTS |
| 7 | Token persistence + per-user device fan-out | **this repo** | EXISTS — `Device.pushToken` |
| 8 | Transport send + terminal/transient classification | **this repo** | EXISTS — `PushNotificationService` |
| 9 | Send/defer/suppress decision, quiet hours, per-category caps | **this repo** | EXISTS — Smart Notification Engine, `notification_deliveries` |
| 10 | `data` payload on the wire (§4) | **FCM engineer** | TO BUILD — nothing is sent today |
| 11 | Deep-link format + client handler + `intent-filter` (§5) | **FCM engineer** | TO BUILD — no scheme is registered today |
| 12 | Delivery-status callback (§6) | **FCM engineer** | TO BUILD — see the constraint stated there |
| 13 | Clearing a dead token after a PERMANENT failure (§7) | **FCM engineer** | TO BUILD — a real, named gap |
| 14 | Child-app push | **nobody yet** | OUT OF SCOPE — see §8 |

## 2. Token registration

**EXISTS. Do not add a second endpoint.**

```
POST /api/v1/pairing/parent-device/push-token
Authorization: Bearer <parent access JWT>     (JwtAuthGuard, @ParentSurface)
Content-Type: application/json

{ "platform": "ANDROID" | "IOS", "pushToken": "<= 500 chars" }

204 No Content
```

- Route: `apps/backend/src/modules/pairing/presentation/controllers/pairing.controller.ts`
- DTO: `RegisterParentDevicePushTokenDto` — `platform` is `@IsIn(['ANDROID','IOS'])`,
  `pushToken` is `@MaxLength(500)`. A longer token is a 400, not a truncation.
- **No `familyId` or `userId` in the body, ever.** Both are taken from the JWT
  (`user.sub`, `user.familyId`). CI rule 3 (`assert-tenant-scoping.ts`) fails the
  build for a request DTO carrying a `familyId`.
- **Idempotent by contract.** The client calls it after login, after a session
  restore, and on every `onTokenRefresh`. Repeat calls with the same token must
  remain a no-op.

Client half (EXISTS): `apps/parent-app/lib/core/notifications/push_registration_service.dart`.

> **G18 note, relevant to you.** On Android the FCM token is obtained and
> registered **without** `POST_NOTIFICATIONS`; the permission governs *display*,
> not registration. The permission is requested later, from
> `NotificationsScreen`, after the value is explained. So expect registered
> tokens that cannot yet display anything — that is intended, not a bug, and it
> is why §7's dead-token rule must not treat "no notification shown" as "bad
> token".

## 3. Device association

**EXISTS.** A push token belongs to a `Device` row, a device belongs to a
`User`, a user belongs to a `Family`.

- Storage: `Device.pushToken` (nullable).
- Fan-out: `PrismaRuntimeAlertRepository.pushToUser` sends to **every** device of
  the target user that has a non-null token.
- **Aggregation rule (optimistic, and deliberately so):** if any one device
  accepts, the household was reached and the outcome is `SENT`. Only when every
  device fails is the outcome a failure, and its class is the worst class
  present. A second phone with a stale token is a cleanup task, not a failed
  delivery.
- Recipient resolution: family **OWNER** first, then any remaining member.

Do not introduce a parallel token table. If you need a per-token send log, hang
it off `Device`.

## 4. Notification payload

### What is sent today

`PushNotificationService.sendToDevice(pushToken, title, body, data?)` maps onto
`admin.messaging().send({ token, notification: { title, body }, data })`.

**The `data` parameter exists on the signature and no caller passes it.**
`pushToUser` calls `sendToDevice(token, title, body)` — three arguments. So today
every push arrives as a bare notification with no structured payload, which is
why no deep link is possible yet. **Item 10 is the insertion point: add `data` at
that call site.** The parameter is already there; nothing needs to change in the
transport.

### The `data` shape this contract fixes

All values are strings — FCM permits nothing else in `data`. Keys are stable and
additive; a consumer must ignore unknown keys rather than fail.

| Key | Source | Notes |
|---|---|---|
| `sourceEventId` | `notification_deliveries.source_event_id` | **The causal key.** Stable across every retry and redelivery. Use it for client-side dedupe. |
| `notificationId` | `notifications.id` | The in-app row, for mark-as-read on open. |
| `type` | `notification_deliveries.type` | e.g. `REWARD_GRANTED`. Vocabulary: `NOTIFICATION_CLASSES` in `apps/backend/src/shared/notifications/notification-class.ts`. |
| `category` | `notification_deliveries.category` | One of `REWARD ACHIEVEMENT GOAL REMINDER SAFETY SUBSCRIPTION PAYMENT AI INSIGHT SYSTEM`. |
| `priority` | `notification_deliveries.priority` | `HIGH` \| `NORMAL` \| `LOW`. |
| `deepLink` | §5 | Optional. Absent means "open the app, do not navigate". |
| `childId` | `notification_deliveries.child_id` | Optional. A UUID — **never** a child's name. |

**Forbidden in `data`, without exception:** a child's name, date of birth, exact
age, raw usage content, message content, or any push token. Ages travel as the
`ageBand` on the decision row and must not be copied here. A push payload is
readable at rest on the device and in FCM's own infrastructure; CONTEXT §3
principle 8 applies (the codebase already refuses to log a token, and logs only
its last six characters).

### How the Smart Notification Engine's decision maps to it

The engine (`notification-engine/application/services/smart-notification-engine.service.ts`)
writes a `notification_decisions` row before anything is delivered:

| Decision | `priority_band` | What reaches FCM |
|---|---|---|
| `SUPPRESS` | `SUPPRESS` | **Nothing.** No FCM call is made. Not your concern, and must not be worked around. |
| `DEFER` | any | Nothing **yet** — a `notification_deliveries` row is written `PENDING` with `defer_reason` (`QUIET_HOURS`) and released later by `quiet-hours-release.service.ts`. FCM is called at release, not at decision. |
| `SEND` | `HIGH` \| `MEDIUM` \| `LOW` | One FCM send, `data.priority` derived from the band. |

Consequences you must respect:

1. **The engine is upstream of you.** By the time a token is used, the questions
   "should this be sent at all", "is it quiet hours", "has this category hit its
   cap" are already answered. Do not re-decide them, and do not add a bypass.
   `test/architecture` guards against notification-engine bypass.
2. **`sourceEventId` is unique per family** (`@@unique([familyId, sourceEventId])`
   on both `notifications` and `notification_deliveries`). One cause produces one
   row, and therefore at most one push, no matter how many retries occur.
3. `notification_decisions.outcome` records what the *pipeline* did as against
   what the *engine* decided. Those two disagreeing is the most useful row in
   that table — feed real send outcomes into it rather than inventing a new log.

## 5. Deep-link format

**TO BUILD — nothing exists today.** No URI scheme is registered: the parent
app's `AndroidManifest.xml` has only the `MAIN`/`LAUNCHER` intent-filter, and no
Dart code handles an incoming link.

Contract:

```
abny://<destination>[/<id>][?<k>=<v>]
```

- Scheme `abny` for both apps; the **destination segment must map onto an
  existing route name** in `apps/parent-app/lib/core/routing/app_routes.dart`,
  minus the leading slash.
- Valid today, because the routes exist and take no arguments:
  `abny://notifications`, `abny://dashboard`, `abny://goals`,
  `abny://goal-review-queue`, `abny://fulfilments`, `abny://subscription`,
  `abny://digital-twin`, `abny://life-timeline`.
- **Id-scoped screens are deliberately NOT deep-linkable yet.** That app has no
  typed-argument router: id-scoped screens are pushed with a `MaterialPageRoute`
  carrying real constructor arguments, precisely so ids do not travel as an
  untyped `Object` through `settings.arguments`. Do not add a stringly-typed
  router to make `abny://child/<uuid>` work. Route to the nearest
  argument-free ancestor and let the user tap through; if a real id-scoped
  deep link is needed, that is a typed-router change and a separate piece of
  work.
- **Unknown or unparseable link ⇒ open the app at its normal start
  destination.** Never crash, never show an error screen. A link is a
  convenience, and a bad one must degrade to "the app opened".
- The link is **advisory**: the notification must be fully understandable from
  `title` + `body` alone, because the OS may deliver a notification the user
  never taps.

Both halves are yours: the `intent-filter` in each manifest, and the Dart
handler.

## 6. Delivery-status callback

**Read this before designing anything here: FCM does not provide per-message
delivery receipts.** `admin.messaging().send()` resolves when FCM *accepts* the
message, which is not proof it was displayed. Any "delivered" claim built on
`send()` resolving would be a false green, and this project's rules forbid one.

What is already true and correct:

`PushNotificationService.sendToDevice` returns a classified
`PushSendResult` — and this is the contract you consume:

| Outcome | Meaning | Caller's obligation |
|---|---|---|
| `SENT` | FCM accepted it | done |
| `SKIPPED` | Firebase not configured in this environment | a documented no-op, **not** a failure |
| `RETRYABLE` | transient (outage, rate limit, internal error) | retry with backoff |
| `PERMANENT` | terminal for this token | **must not** retry |

The queue already acts on that: `notification_deliveries` carries
`attempt_count`, `next_attempt_at`, `last_error`, and a state machine
`PENDING → DELIVERING → DELIVERED | SUPPRESSED | DEAD` closed by a database CHECK
constraint. Eight attempts with doubling backoff, then a visible `DEAD` row that
says *why*. `notification-delivery-sweep.job.ts` drives it.

So the honest options for item 12, in preference order:

1. **Report acceptance, and name it that.** Feed the four outcomes above into
   `notification_decisions.outcome` / `outcome_reason`. Cheap, truthful, and it
   requires no new endpoint. Recommended.
2. **Client-side open receipt.** The app reports back when a notification is
   *opened* (it has `notificationId` and `sourceEventId` from §4). That measures
   engagement, not delivery, and must be labelled as such.

Whichever is built: **do not add a field named `delivered` that means
`accepted`.** If a new endpoint is needed, it belongs beside the existing
notification operations controller
(`modules/notifications/presentation/controllers/notification-operations.controller.ts`),
not as a new module.

## 7. Invalid and stale tokens

**Half exists. The other half is a real gap and it is yours (item 13).**

EXISTS — the classification. `PERMANENT_FCM_CODES` in `push-notification.service.ts`
is a **named set**, not a substring match, so adding a code is a deliberate edit:

```
messaging/invalid-registration-token
messaging/registration-token-not-registered
messaging/invalid-argument
messaging/invalid-recipient
messaging/mismatched-credential
messaging/invalid-package-name
```

An **unrecognised** code resolves to `RETRYABLE`, deliberately: treating an
unknown code as permanent silently loses a deliverable message, while treating it
as retryable costs at most eight attempts and then leaves a readable `DEAD` row.

**THE GAP, stated plainly.** A `PERMANENT` outcome classifies the failure but
**nothing clears `Device.pushToken`**. The dead token stays in the table and is
re-sent to on every subsequent fan-out, forever. Because the fan-out rule is
optimistic (§3), a household with one live phone and one dead token looks
perfectly healthy while half of every fan-out is wasted — so this will not
surface as an incident, only as slow noise.

Required behaviour:

- On `messaging/registration-token-not-registered` or
  `messaging/invalid-registration-token` for a specific token, **null that
  `Device.pushToken`**.
- Do it per token, from the outcome of that token's own send — not for every
  token in the fan-out.
- **Never delete the `Device` row.** The device still exists; only its token
  died. The next `POST /pairing/parent-device/push-token` restores it.
- Do **not** clear a token on `RETRYABLE`, and do **not** clear it on `SKIPPED`
  (that only means this environment has no Firebase).
- Rotation needs no special handling: the client re-registers on
  `onTokenRefresh`, and registration is idempotent (§2).

## 8. Out of scope

- **Child-app push.** `apps/child-app` declares no `firebase_messaging`
  dependency and has no FCM code. Its notifications are **local** — posted by
  its own foreground service and `RuntimeAlertNotifier`. It needs
  `POST_NOTIFICATIONS` (fixed in G18) but not FCM. Adding FCM to the child app is
  a separate decision with its own child-safety review, not part of this
  contract.
- **iOS.** `platform: "IOS"` is accepted by the endpoint and the client sets it,
  but APNs certificates, entitlements and the iOS build are covered by
  `docs/release/IOS_READINESS.md`. Note only that on iOS an APNs token is not
  issued until the user authorises notifications, which is why the parent app
  still requests the permission eagerly on that platform and not on Android.
- **Re-deciding whether to notify.** That is the Smart Notification Engine's job
  (§4).

## 9. HUMAN DECISION REQUIRED

1. **Which Firebase project(s).** One project with two Android apps, or separate
   projects per environment? Affects how many `google-services.json` files and
   service-account secrets exist. Nothing here can be built until this is chosen.
2. **Item 12's shape** — acceptance reporting (option 1) or open receipts
   (option 2), or both. Option 1 is recommended and cheapest.
3. **Whether a dead token should notify anyone.** Nulling a token silently means
   a parent stops receiving push with no signal. An in-app "notifications are not
   reaching this phone" prompt is arguably better — the parent app already has
   the banner for it (G18, `notifications.permTitle`) and it could be reused.
