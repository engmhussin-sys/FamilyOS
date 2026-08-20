# ABNY — CONTROLLED PILOT TEST PLAN · مصر / السعودية

**This is a test plan, not a feature request.** Everything it exercises already exists. Nothing here asks for new pilot-management tooling — `pilot_invites` and the cohort field are already in the schema and already used by the demo seed.

Run it only after the Golden Device Smoke Test passes on real hardware.

---

## Shape of the pilot

| | |
|---|---|
| Households | A small number per market — enough to see two timezones and two currencies behave differently, few enough that you can phone every one of them |
| Markets | **مصر** (`Africa/Cairo`, EGP) and **السعودية** (`Asia/Riyadh`, SAR) |
| Duration | Long enough to cross at least two weekly boundaries and one subscription event |
| Cohort id | `HUMAN DECISION` — the demo seed uses `demo-pilot-2026`; pick a real one so pilot data is separable from demo data forever |

**The single most important sampling rule:** at least one household in each market must have a child whose usual activity crosses local midnight. Almost every business-date defect this project has produced hid in exactly that gap, and in August both countries sit at UTC+3 — so a test run in summer will not distinguish them by clock alone. Pick households whose **local** midnight matters.

---

## What each household must exercise

| # | Area | What to confirm |
|---|---|---|
| 1 | **Parent registration** | Account created; country chosen deliberately — it sets the household timezone and currency for everything after |
| 2 | **Child pairing** | Invitation → accept → device register → verify → **parent approval** → child home. The approval is a required step, not a formality |
| 3 | **Timezone / country** | A day rolls over at the family's own midnight, not UTC. Check the streak, the daily goal reset and the notification budget the morning after a late-evening session |
| 4 | **Goals** | Create, receive, complete, verify, reward. Once — not twice |
| 5 | **Quran** | A faith practice logged and reflected in the child's progress |
| 6 | **Study** | A learning session recorded; the progress card moves |
| 7 | **Exercise** | Activity logged from the app's own button — and confirm the badge for a first-ever activity goal actually arrives |
| 8 | **Hydration** | Same, through the hydration button. First-ever hydration badge arrives once, and the XP matches the catalogue amount, not double |
| 9 | **Rewards** | Points, level, streak, badges, and a redemption from the store |
| 10 | **Evidence** | Recitation audio and a photo, uploaded and submitted. Watch for a failed submission after a successful upload — the orphan case |
| 11 | **Notifications** | The child gets the child's sentence, the parent gets the parent's, and neither gets the same sentence twice. Quiet hours defer rather than delete |
| 12 | **Deep links** | Every tap opens the surface it names, from a cold start as well as a warm one |
| 13 | **Safety** | The refusal path, from a real child's phrasing rather than a test string. The parent's escalation arrives; the child sees a calm in-band Arabic reply |
| 14 | **Parent approval** | Approve and reject. A rejection must not shame the child |
| 15 | **Subscription state** | Trial, active, and grace period. Confirm a grace-period household can still cancel — that transition exists and is tested; the pilot is where a human confirms it reads correctly |

---

## What the pilot is really measuring

Not whether the code runs — 5,383 backend tests already answer that. The pilot answers three things tests cannot:

1. **Does the Arabic sound like a person?** Register, warmth, and whether a child of six and a child of fifteen both feel spoken to rather than processed. This is the single largest untested surface in the product.
2. **Does the daily rhythm fit a real family?** Notification volume, quiet hours, and whether the day boundary lands where the family thinks their day ends.
3. **Does a parent understand what they are being told?** Every parent notification claims to say what happened and whether action is needed. A parent who has to open the app to find out has been told nothing.

---

## Known limits during the pilot

| Limit | Consequence |
|---|---|
| Payments (Paymob / Fawry) | Merchant onboarding is 4–8 weeks. Subscription **state** is testable; taking real money is not |
| Push delivery | `DELEGATED`. In-app inbox and deep links are testable; a system banner needs the transport owner |
| Staging | No deployment exists. The pilot runs against a backend you host |
| iOS | Not in scope. Supervision requires an Android device |

---

## Recording

Per household, per area: works / does not work / **felt wrong**. That third column is the one worth having — it is the only signal in this whole project that no test can produce, and it is the reason to run a pilot at all rather than shipping.
