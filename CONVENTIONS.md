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

### The mobile toolchain is guarded separately, because it hides in four files

Flutter's version lives in a workflow variable, AGP's and Kotlin's in `apps/*/android/settings.gradle`, Gradle's in a wrapper properties file. None of them is a `package.json`, which is exactly how they went stale unnoticed. `scripts/ci/assert-mobile-toolchain-current.py` reads all four out of the repository, asks the authoritative source for each, and fails the build on a gap. `scripts/ci/test_mobile_toolchain_guard.py` proves the guard can still read this repository's pins — a guard that silently stops matching is worse than no guard.

**These four upgrade together, in this order, or not at all:**

```
Google Play requires targetSdk 36 from 31 August 2026
  └─ AGP refuses a compileSdk above its own ceiling
      └─ AGP 9.x requires Gradle 9.5.0 or newer
          └─ and a Kotlin version its plugin accepts
              └─ and Flutter 3.47+ is the release whose templates target AGP 9+
```

Nobody upgrades one of these. Somebody upgrades all four, in order, then raises `compileSdk`/`targetSdk`, then **builds both apps** — `flutter analyze`, `flutter test`, and the APK job. A mobile toolchain bump that was not built is not an upgrade.

**Done once, on 2026-08-22**, and prompted by the Play deadline rather than by this guard — which is the failure mode the guard now exists to prevent a second time. The set landed was Flutter 3.47.0 · AGP 9.3.0 · Gradle 9.7.1 · Kotlin 2.4.10 · compileSdk/targetSdk 36, every number resolved from its authoritative source, and **it has not been built** — see `MOBILE_BUILD_HANDOFF.md` §1.

### A version that cannot be obtained is never guessed

C-5 governs here without exception. Where an environment cannot reach `storage.googleapis.com`, `dl.google.com`, `services.gradle.org` or `pub.dev`, the correct output is a named gap and a guard that will catch it on a machine that can — **never a version number written from memory.** A pin invented for two apps that run on children's phones, in an environment where nothing can build them, is the worst possible form of that mistake.

---

## C-7 · WHAT PRODUCTION RUNS IS A *RUNTIME* DEPENDENCY

The production image installs with `npm ci --omit=dev`. Anything imported by
code that runs there — `apps/backend/src/**`, and the files the Dockerfile's
runtime stage copies (`prisma.config.ts`, `scripts/predeploy.sh`) — **must be
in `dependencies`, never `devDependencies`.**

### Why this is a convention and not a note

Three defects of this exact shape shipped into one branch, and **none of them
was reachable by any test.** Tests run against the full dev install; the
failure exists only in an image built with `--omit=dev`:

| Package | Imported by | Consequence |
|---|---|---|
| `dotenv` | `prisma.config.ts` | the Prisma CLI in the image cannot load its own config — the release step dies |
| `@prisma/adapter-pg` | `PrismaService` | **the container crashes on startup**: `Cannot find module 'pg'` |
| `prisma` | `prisma.config.ts` (`defineConfig`) | present only via a hand-maintained `COPY` line in the Dockerfile |

The second one was found by reproducing the Docker runtime stage on disk and
booting it. It would otherwise have been found by Railway, in production, as a
crash loop.

### The guard

`npm run ci:runtime-deps` (`apps/backend/scripts/ci/assert-runtime-deps.ts`),
blocking in CI. It reads first-party imports and fails on any that names a
package outside `dependencies`. `import type` is exempt, because it is erased
by the compiler; an inline `import { type A, B }` is **not**, because `B` still
emits a require.

### What the guard does not prove, and the ten-minute check that does

The guard reads *first-party* imports. It cannot prove the whole production
dependency tree resolves — `pg` is never imported by `src/`, it arrives through
`@prisma/adapter-pg`. **Before a release, boot the runtime stage:**

```sh
# from apps/backend, with a full install present
SIM=/tmp/runtime-sim && rm -rf $SIM && mkdir -p $SIM/scripts
cp package.json package-lock.json prisma.config.ts $SIM/
cp -r prisma dist $SIM/ && cp scripts/predeploy.sh scripts/predeploy-schema-probe.js $SIM/scripts/
cd $SIM && npm ci --omit=dev
cp -r <full-install>/node_modules/.prisma  node_modules/.prisma
cp -r <full-install>/node_modules/@prisma  node_modules/@prisma
DATABASE_URL=… REDIS_URL=… node dist/main.js     # must reach "Nest application successfully started"
curl -s localhost:3000/health/ready              # must be 200 with database:true, redis:true
```

That is not a substitute for building the image where Docker Hub is reachable.
It is what to do where it is not — and it is strictly better than assuming.
