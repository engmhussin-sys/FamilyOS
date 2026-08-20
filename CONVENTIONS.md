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
