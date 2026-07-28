# Definition of Done

This is the checklist every feature in this project — backend, Admin
Dashboard, or Child Agent — must satisfy before it is considered done, not
just "written." A feature missing any item below is **not finished**,
regardless of how much of it works.

This document is descriptive of what this project has already been doing
since its first step (see every `docs/architecture/*.md` file's
"Verification performed in this session" section) — Decision-015 asked for
it to be written down explicitly rather than left as an unstated habit.

---

## 1. Code

Must pass the full verification pipeline (Decision-014) **before** it is
considered anything more than a draft:

```
install dependencies
      ↓
static type check   (tsc --noEmit  /  flutter analyze)
      ↓
format check         (prettier/eslint  /  dart format --set-exit-if-changed)
      ↓
unit tests
      ↓
integration tests    (where applicable — real DB/services, not mocks)
      ↓
build                (vite build  /  nest build  /  flutter build)
      ↓
manual smoke test    (only for user-facing flows a machine can't judge)
```

Per Decision-014, this must not depend on a human remembering to run it —
see `.github/workflows/ci.yml`, which runs the automatable stages
(everything above "manual smoke test") on every push/PR. A feature whose
CI is red is a draft, not a review candidate.

## 2. Tests

- Every new service/use-case has unit tests covering: the happy path,
  the primary failure/rejection path, and any ownership/authorization
  check specific to that code (this project's established pattern: e.g.
  every `ChildrenService`-dependent method has a test asserting the
  downstream repository/API is **never called** when ownership fails).
- Test names describe behavior, not implementation ("rejects when the
  child belongs to a different family," not "test4").

## 3. Documentation

- A `docs/architecture/<module>.md` entry explaining: what was built, the
  non-obvious design decisions and why, and explicit "known follow-ups"
  for anything deliberately deferred (never silently skipped).
- Inline code comments explain *why*, not *what* — the code itself should
  make "what" obvious.

## 4. Architecture Updated

- If the feature introduces a new cross-cutting pattern (e.g. the
  family-ownership-check pattern from `ChildrenService`, or the
  refresh-and-retry pattern shared between `httpClient.ts` and
  `api_client.dart`), it is documented once as a reusable pattern, not
  re-explained per module that uses it.
- `README.md`'s status tables and doc-index are updated in the same
  change, not as a separate cleanup pass.

## 5. API Updated

- New/changed endpoints (or platform-channel methods, for the Child
  Agent) are reflected in the relevant module's architecture doc's API
  surface table.
- Breaking changes to an existing contract require an explicit note on
  what consumes that contract and how they're affected (see
  `docs/specifications/http_client.md` for the shared-contract mechanism
  that exists specifically to catch this across Dashboard/Flutter).

## 6. Database Updated

- Schema changes go through `apps/backend/prisma/schema.prisma` with a
  matching entry in `docs/database/README.md` explaining the new
  table/field's purpose, indexes, and any security/retention
  implications — the same standard every table has had since the first
  schema step.

## 7. Changelog Updated

- Each shipped step's ZIP delivery message (or, once this project moves
  to a real CI/CD pipeline, its PR description) states what changed in
  plain language — this project's convention so far (every step's chat
  summary + suggested commit message) satisfies this; formalizing it into
  a `CHANGELOG.md` is a reasonable follow-up once the project has an
  actual release cadence, not before.

## 8. Security Review

- Every new endpoint/platform capability answers, explicitly: who can
  call this, what does it trust from the client vs. verify itself, and
  what's the worst case if it's misused? This project's established
  pattern (see every module's "Security implications" or equivalent
  section) is the bar — not a separate formal sign-off step at small
  scale, but a mandatory section, not an afterthought.

## 9. Performance Review

- Any new hot-path code (called per-request, or — for the Child Agent —
  called on every Accessibility event) has a stated cost/frequency
  tradeoff, even briefly. Any endpoint doing more than a single-table
  lookup gets a one-line note on indexing/query shape (already the
  project's habit — see `docs/database/README.md` §4's indexing
  rationale).

## 10. Observability (Decision-049: "No Feature Without Observability")

Designed **with** the feature, not after it ships. Every feature's
architecture doc must answer, explicitly, before implementation is
considered complete:
- **How do we monitor it?** What signal (metric, log, event) proves it's
  running at all.
- **How do we measure success?** A stated metric, not a vague "it works."
- **How do we know it broke?** What specifically indicates failure —
  distinct from simply "no errors were thrown."
- **How do we explain a problem when one occurs?** Per Decision-047's
  explainability principle (`risk-score-framework.md` §6) applied
  generally: a black-box "something is wrong" is not sufficient for any
  feature a parent or support engineer will need to reason about.

A feature whose architecture doc doesn't answer these four is missing
this criterion — same enforcement as every other item in this checklist,
not a softer aspiration.

---

## 10. Observability (Decision-049 — "No Feature Without Observability")

Designed alongside the feature itself, not added after the fact. Every
feature must have an answer to each of these before it's considered
done:
- **How do we monitor it?** What signal shows it's working right now —
  not "we'd notice if it broke," an actual signal.
- **How do we measure success?** A real metric, not "it doesn't throw an
  error."
- **How do we know it broke?** A concrete alert/threshold condition, not
  "a parent complains and someone investigates."
- **How do we explain a failure when it happens?** Per Decision-047's
  Explainability principle, generalized beyond Risk Score specifically —
  any feature that can reach a "something's wrong" state must be able to
  state *why*, not just flag *that* something's wrong.

A feature whose answers to these four questions are deferred to "we'll
add monitoring later" does not satisfy this item. Per Decision-049, this
is a Definition-of-Done gate, not a nice-to-have follow-up.

---

## What this means in practice

A feature is **not done** if:
- It has code but no tests.
- It has tests but no architecture doc explaining *why* the design is
  what it is.
- It touches the database but the schema doc wasn't updated in the same
  change.
- It's "probably fine" but CI hasn't actually run green.

This is a checklist to apply honestly, including to work already
delivered — if an earlier step in this project is later found to be
missing an item here, that is a defect to log and fix, not something the
Definition of Done retroactively excuses.
