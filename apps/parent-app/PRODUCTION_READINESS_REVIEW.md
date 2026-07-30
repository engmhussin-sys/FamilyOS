# Parent App — Production Readiness Review

**Verdict: NOT YET Production Ready.** 6 real issues found and fixed in
this review. 3 genuine gaps remain open (documented below, not
silently skipped) — each requires real feature work beyond what a
review pass should do unprompted.

---

## 1. UI/UX Review

| Screen | Loading | Empty | Error | Retry | Success FB | Responsive | Dark Mode | RTL/LTR | Font Scaling |
|---|---|---|---|---|---|---|---|---|---|
| Splash | ✅ | N/A | ✅ | N/A | ✅ | ✅ | ✅ fixed | ✅ | ✅ |
| Login | ✅ | N/A | ✅ | ✅ | ✅ | 🔴→✅ fixed | ✅ fixed | ✅ | ✅ |
| Register | ✅ | N/A | ✅ | ✅ | ✅ | 🔴→✅ fixed | ✅ fixed | ✅ | ✅ |
| Create Family | ✅ | N/A | ✅ | ✅ | ✅ | 🔴→✅ fixed | ✅ fixed | ✅ | ✅ |
| Dashboard | ✅ | ✅ | 🔴→✅ fixed | 🔴→✅ fixed | ✅ | ✅ | ✅ fixed | ✅ | ✅ |
| Add Child | ✅ | 🔴→✅ fixed | ✅ | ✅ | ✅ | ✅ | ✅ fixed | ✅ | ✅ |
| Notifications | ✅ | ✅ | 🔴→✅ fixed | 🔴→✅ fixed | ✅ | ✅ | ✅ fixed | ✅ | ✅ |
| Settings | N/A | N/A | N/A | N/A | ✅ | ✅ | ✅ fixed | ✅ | ✅ |

**ISSUE 🔴 → FIXED: no `SingleChildScrollView` on Login/Register/Create
Family.** On a small device with the keyboard open, fields + button
could exceed available height and throw a `RenderFlex` overflow error.
Wrapped all three.

**ISSUE 🔴 → FIXED: Dashboard/Notifications silently swallowed errors.**
Both `catch` blocks discarded the exception, leaving a state visually
identical to "no data" — a real failure was indistinguishable from an
empty account, no retry path. Added explicit error state + Retry button.

**ISSUE 🔴 → FIXED: Add Child had no empty state.** With zero children,
the dropdown rendered with no items, and Generate Code was still
tappable with a null `childId`. Added an explicit "add a child first" message.

**ISSUE 🔴 → FIXED: no dark theme existed.** `AppTheme` had only
`light()`. Added `AppTheme.dark()`, wired `ThemeMode.system` — a device
in dark mode would previously have silently fallen back to Flutter's
default Material theme.

**PASS: RTL/LTR** — handled globally via `Directionality`, no screen hardcodes direction.
**PASS: Font scaling** — no fixed-pixel text outside theme styles, which respect system font scale.

---

## 2. Navigation Review

**ISSUE 🔴 → FIXED: dead-end back-navigation to Login after
registration.** `Register→FamilySetup` used `push`, so the stack was
`[Login, Register]`. Register's success handler used
`pushReplacementNamed`, which only replaces the TOP — leaving
`[Login, FamilySetup]`, then `[Login, Dashboard]` after FamilySetup's
own replace. **Pressing back on Dashboard for a freshly-registered user
would return them to Login** — a real bug. Fixed with
`pushNamedAndRemoveUntil(familySetup, (route) => false)`, clearing the
whole stack.

**PASS: no dead routes** — all 8 routes reachable, traced against every navigation call.
**PASS: no navigation loops.**
**Deep Links: honestly out of scope, not a failure** — no deep-link
package/config exists; route names are consistent (the prerequisite),
actual infrastructure is real separate work.

---

## 3. API Review

**ISSUE 🔴 → FIXED: no timeout on `Dio` at all.** A hung request would
wait indefinitely, no error ever surfacing. Added
`connectTimeout: 15s` / `receiveTimeout: 20s` + specific timeout/offline messages.

**ISSUE 🔴 → FIXED: no session-expiration redirect.** `ApiClient`
cleared the session on failed refresh but nothing told the app the user
was logged out. Added `sessionExpiredProvider` + a global
`navigatorKey` — a failed refresh now force-navigates to Login from
wherever the user is.

**PASS: Error Mapping** — `ApiException` normalizes every failure.
**PASS: Unauthorized Handling / Refresh Token** — coordinated single-refresh-on-401.

**ISSUE 🔴 remains OPEN — Network Offline detection.** No
`connectivity_plus` or equivalent exists — no proactive offline banner,
only a clear error after a request times out. Not fixed here: this is
a feature addition, not a bug.

---

## 4. Offline Review

**ISSUE 🔴 remains OPEN — no offline capability exists.** Unlike
`child-app`'s real `OfflineQueue`, the Parent App has zero local
caching/queueing. Losing connectivity mid-session fails every next
action outright (with a clear message post-fix, but no offline-first
behavior). Not fixed here — real feature work (what to cache, conflict
resolution), matching Sprint 10's own "no new Features" boundary.

---

## 5. Security Review

**PASS: Secure Storage / Token Lifecycle / Logout / Session Expiration.**

**ISSUE 🔴 remains OPEN — no screenshot protection.** Dashboard shows
children's risk/trust data. No `FLAG_SECURE` (Android) equivalent set.
Not fixed here — platform-specific (no iOS equivalent exists at all,
itself needing a documented decision), a hardening feature not a bug.

**PASS: Clipboard** — nothing sensitive programmatically copied.
**PASS: Sensitive Logging** — zero logging calls touch tokens/passwords/bodies anywhere.

---

## 6. Performance Review

**ISSUE 🔴 → FIXED: locale changes didn't trigger rebuilds.**
`ref.watch(localeControllerProvider.notifier)` returns a stable
reference — Riverpod doesn't rebuild on a notifier-only watch. All 8
screens using translation had this bug: changing language in Settings
wouldn't update an already-built screen. Fixed by also watching the
state provider in every build method.

**PASS: Lazy Lists** — Notifications uses `ListView.builder`; Dashboard's
non-builder list is fine at realistic family sizes.
**PASS: API Calls** — Dashboard's 3 reads run via `Future.wait` (parallel).
**PASS: Image Loading** — no network images used yet, trivially N/A.

---

## 7. Code Quality Review

**PASS: Dead Code** — none found.
**PASS: TODO/FIXME** — zero matches, full-codebase grep.
**Minor, not fixed:** duplicated try/catch-and-setState pattern across
3 form screens — idiomatic Flutter, extracting it is a real refactor
this review's own scope argues against doing unprompted.
**PASS: Unused imports/providers** — every provider consumed, no unused imports found.

---

## Summary

| Category | Result |
|---|---|
| UI/UX | 4 issues found and fixed |
| Navigation | 1 issue found and fixed |
| API | 2 fixed, 1 open (offline detection) |
| Offline | 1 open (no offline capability) |
| Security | 1 open (screenshot protection) |
| Performance | 1 issue found and fixed |
| Code Quality | Clean |

**6 real bugs fixed. 3 genuine gaps remain open**, each requiring real
feature work, each now explicitly documented rather than silently
absent. Per the review's own rule — not every item is a clean PASS —
**Parent App is not declared Production Ready this session.** Recommend
either a scoped follow-up closing the 3 open items, or explicitly
accepting them as known v1.0 limitations (same treatment
`KNOWN_LIMITATIONS.md` already gives comparable gaps elsewhere) before
proceeding to Sprint 11 regardless.
