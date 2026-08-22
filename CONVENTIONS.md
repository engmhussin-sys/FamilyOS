# ABNY — CONVENTIONS

Rules the owner has set. They are recorded here, not in a conversation, so they survive the conversation.

---

## C-1 · CODE IS DELIVERED AS A ZIP, PATHS INTACT

> **«أي تسليم كود يكون في ملف مضغوط، وداخله الملفات المعدّلة بنفس مساراتها، حتى أنزّلها ثم أنسخها مرة واحدة.»**

Every code handover is a `.zip` whose entries are **repository-relative paths**. It extracts straight over the project folder — no wrapper directory, no rearranging, no per-file copying.

**Never** deliver code as: a patch to apply, a snippet to paste, a file list to assemble by hand, or an archive with a wrapper folder at its root.

### Two shapes, and when each is right

| | Delta zip | Full tree |
|---|---|---|
| Contains | only the files that changed | every tracked file |
| Use when | continuing work on a folder that is already up to date | first handover, or the folder is stale / of unknown state |
| Build with | `scripts/make-delivery-zip.sh <range>` | `git archive --format=zip -9 -o FamilyOS-code.zip HEAD` |

**When in doubt, send the full tree.** A delta applied to the wrong baseline is worse than a redundant 5 MB download: it leaves a folder that is half one version and half another, and nothing announces it.

### A zip cannot delete — so it must say so

Extracting adds and replaces. It never removes. A file deleted upstream survives on the receiving side, still compiles, and quietly does the old thing.

So every delivery zip carries a `_DELIVERY/` folder:

| File | What it is |
|---|---|
| `MANIFEST.txt` | every path in the delivery with its status, the commits, and how to apply |
| `DELETE.ps1` | the removals as one paste-able PowerShell command (Windows paths) |
| `DELETE.sh` | the same for macOS and Linux |

**Order matters: run the DELETE script first, then extract.** `_DELIVERY/` is notes, not source — delete it after use.

### Building one

```bash
scripts/make-delivery-zip.sh HEAD~1..HEAD        # the last commit
scripts/make-delivery-zip.sh main..HEAD          # everything on this branch
scripts/make-delivery-zip.sh abc1234..def5678    # any range
```

The default filename carries the range's head sha, so two deliveries never collide in a Downloads folder.

The script handles the case that catches people out: a **rename** deletes its old path, and `--diff-filter=D` does not report that. Both sides are collected, so the old name reaches `DELETE`.

---

## C-2 · SECRETS ARE NEVER DELIVERED, ECHOED OR COMMITTED

No credential, token, keystore, `google-services.json`, `.env` or password is ever written into a file that is handed over, printed in a reply, or committed. The owner supplies secrets directly to GitHub or Railway; they do not pass through the conversation.

`INTERNAL_ADMIN_API_KEY` in particular never reaches browser JavaScript. The dashboard holds it in memory only — not `localStorage`, not a cookie, not the URL — and re-asks after every page refresh. That is deliberate: an operator key that survives closing the tab is a key that can be taken off the machine.

---

## C-3 · EVIDENCE WORDS MEAN WHAT THEY SAY

Used strictly, never loosely:

`RUNTIME VERIFIED` · `BUILD VERIFIED` · `STATIC VERIFIED` · `CODE REVIEWED` · `BLOCKED` · `DELEGATED` · `HUMAN DECISION` · `NOT TESTED`

A thing that was read is `CODE REVIEWED`. A thing that was executed is `RUNTIME VERIFIED`. **No readiness percentage is ever given**, here or anywhere — a measured number, or a stated absence.

---

## C-4 · A FAILING TEST IS NEVER "FIXED" BY WEAKENING IT

Not by deleting it, skipping it, mocking it away, or lowering its expectation to whatever the code currently does. A test that goes red either found a defect — fix the defect — or encodes a stale expectation, in which case the new expectation is **re-derived from what the code should do** and the reason is written down beside it.

---

## C-5 · NOTHING IS INVENTED

No fabricated credential, version pin, URL, service name, benchmark or test result. A value that cannot be obtained is marked `HUMAN DECISION / ENVIRONMENT VALUE REQUIRED` and named, so the gap is visible rather than papered over with a plausible-looking guess.

---

## C-6 · THE PROJECT BUILDS ON CURRENT RELEASES, NEVER OLD ONES

> **«استخدام أحدث الإصدارات فى بناء المشروع وعدم استخدام اصدارات قديمة.»**

Every dependency, runtime and toolchain sits on its **latest major**. Staying a major behind is a decision, and a decision needs a reason; "we did not get to it" is not one.

### Enforced, not remembered

`npm run ci:deps-current` (`apps/backend/scripts/ci/assert-dependencies-current.ts`) compares the declared major of every package in every manifest against the registry's `latest` and **fails the build** on a gap. It runs in CI as a blocking step.

Minors and patches are not policed: a caret range already floats to the newest compatible release on every install, so a minor gap is a lockfile detail. A **major** gap is always a choice.

### The exemption list is the rule, not a hole in it

A package may be held back only by an **upstream fact** — a peer range that excludes the version we run, or a tool that has not shipped support. Each exemption must name its blocker *and* the condition that removes it; the guard rejects an entry missing either, and fails the build when a blocker has expired and the exemption was left behind.

Where a tool blocks the toolchain, the tool is replaced rather than the toolchain held back. Already done for this reason:

| Removed | Because | Replaced by |
|---|---|---|
| `ts-jest` | `peerDependencies.typescript: ">=4.3 <7"` — no published tag supports TypeScript 7 | `@swc/jest` (types are checked once by `tsc --noEmit`, not re-checked in 240 test files) |
| `ts-node` | Uses a compiler API TypeScript 7 does not expose | `tsx` |
| `@nestjs/cli` | *"TypeScript 7.0 ships the `tsc` executable only; the compiler API is expected to return in 7.1"* | `tsc -p tsconfig.build.json` for build, `tsx watch` for dev |

### The one thing "latest" does NOT mean

**The runtime tracks Active LTS, not Current.** Node 26 is Current; the project runs **Node 24**, and `@types/node` is pinned to match it. Typing against a runtime that is not deployed lets a call to a non-existent API typecheck cleanly — which is the exact failure the types exist to prevent. This is the single standing exemption, and it moves the day Node 26 becomes Active LTS.
