# ABNY — GOLDEN DEVICE SMOKE TEST

**One pass, two physical Android phones, one local backend.** This is the first time ABNY code runs on real hardware. Nothing in this document needs Firebase, a keystore, Play Console, Paymob or Fawry.

Run it top to bottom. Record `PASS` / `FAIL` / `BLOCKED` per step and, on any `FAIL`, the exact screen and the exact message. Do not fix as you go — finish the pass first, so you learn everything one build teaches you rather than one thing per build.

---

## What you need

| | |
|---|---|
| Phones | Two Android devices, API 21+, USB debugging on. One is the parent, one is the child |
| Backend | Running on your machine: `docker compose up -d` then `cd apps/backend && npx prisma migrate deploy && npm run start:dev` |
| Network | Both phones on the same Wi-Fi as your machine. Find your LAN IP (`ipconfig`) — the phones cannot reach `localhost` |
| API base | The debug build takes `--dart-define=API_BASE_URL=http://<your-lan-ip>:3000`. `MOBILE_BUILD_HANDOFF.md` has the exact command |

**Seed data is optional and probably unhelpful here.** `npm run seed:demo` fills the database with 30 synthetic households, which is right for the dashboard and wrong for this test — you want to watch a real household come into existence from nothing.

---

## The pass

| # | Step | What must happen | Notes |
|---|---|---|---|
| 1 | **Install** | `adb install app-debug.apk` on each phone; both launch to a first screen without crashing | The single most informative step. A crash here is a `P0 BUILD BLOCKER` |
| 2 | **Arabic and RTL** | Every screen is Arabic, laid out right-to-left, no `[missing key]`, no English fallback, no Latin digits inside an Arabic sentence | Check the first three screens carefully; the rest by eye as you go |
| 3 | **Register** | Parent app → create an account → lands on the dashboard | Use a real address you control. Country selection (مصر / السعودية) is what sets the household timezone — **pick deliberately, it drives every business date after this** |
| 4 | **Add a child** | Parent creates a child with a name and age | The age band drives the AI copy and every safety ceiling |
| 5 | **Pair the child device** | Parent generates a pairing invitation → enter the code on the child phone → child device registers and verifies → **parent approves** → child phone reaches its home screen | Four server steps, and the parent's approval is one of them. A child device that reaches home without an approval is a `P0 AUTHORIZATION` failure — stop and report it |
| 6 | **Parent sees the child** | The child appears on the parent dashboard with live state, not a placeholder | |
| 7 | **Create a goal** | Parent creates a goal for the child | Pick one with evidence off for now; evidence is step 12 |
| 8 | **Child receives it** | The goal appears on the child phone | If push is not configured this arrives on refresh, not as a banner — that is expected, see *Push* below |
| 9 | **Child completes it** | Child marks the goal done | The child must not be able to set points, mark itself verified, or approve anything. If any of those is reachable, that is a `P0 AUTHORIZATION` failure |
| 10 | **Parent verifies** | The completion appears in the parent's approvals and the parent approves it | |
| 11 | **Reward lands** | Child's points/XP increase by the configured amount **once**. The child is told, in Arabic | Approve the same completion twice if the UI allows: the total must not move the second time |
| 12 | **Evidence upload** | Create a goal that requires evidence → child records audio or picks a photo → uploads → submits | **First real exercise of five packages that have never resolved in any sandbox.** A failure here is expected-ish and valuable; capture the exact error |
| 13 | **Notification arrives** | The child's and the parent's messages appear in their in-app inboxes | Without Firebase this is the inbox, not a system banner. That is the honest scope of a debug build |
| 14 | **Notification tap → deep link** | Tapping a notification opens the screen it is about — not a generic inbox, not a blank page | The registry and both routers were verified statically; this is the first runtime proof |
| 15 | **Cold-start deep link** | With the app fully closed: `adb shell am start -a android.intent.action.VIEW -d "abny://goals"` → the app launches **onto that surface** | Then repeat with the app in the background (warm start). Both paths were wired blind — this step is why |
| 16 | **Safety rejection** | Somewhere the child can type free text, enter something the filter must refuse | The child must get a calm, in-band Arabic response — **never** a raw error, never a blank card, never an English exception. And the parent's alerts must show the escalation |
| 17 | **Logout and restart** | Parent logs out and back in; both apps are force-stopped and relaunched | State survives; nothing asks the child to pair again |

---

## Push notifications — what this build can and cannot show

A debug APK with no `google-services.json` **cannot receive a push**. Steps 13 and 14 exercise the in-app inbox and the deep-link router, which is the part ABNY owns and the part that has never run.

The transport — token acquisition and FCM delivery — is owned by another engineer and is `DELEGATED`. Do not treat a missing banner as a defect in this pass. What you are proving here is that when a push does arrive, the payload it carries opens the right screen.

---

## What counts as stopping the pass

Only these. Everything else goes in the notes column and the pass continues:

- **P0 CRASH** — an app that will not launch or dies on a core screen
- **P0 AUTHORIZATION** — a child reaching a parent-only surface, or approving/verifying/scoring anything
- **P0 CHILD SAFETY** — unsafe text reaching a child, or a refusal that shows a raw error
- **P0 DATA LOSS** — a completion, reward or approval that disappears
- **P0 BUILD BLOCKER** — the APK cannot be produced or installed

A cosmetic misalignment, an awkward sentence, a slow screen, a missing empty state — write it down, keep going. It is `POST-PILOT`.

---

## Recording the result

For each step: `PASS` / `FAIL` / `BLOCKED`, plus the screen name and the verbatim message on any failure. A screenshot of every failure is worth more than a description of it.

When the pass is done, the single most useful thing you can send back is the list of failing step numbers with their messages — that is enough to fix without another round trip.
