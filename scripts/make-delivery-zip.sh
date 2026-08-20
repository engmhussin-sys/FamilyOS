#!/usr/bin/env bash
# =============================================================================
# DELIVERY ZIP — the owner's standing rule, made repeatable.
#
#   "أي تسليم كود يكون في ملف مضغوط، وداخله الملفات المعدّلة بنفس مساراتها،
#    حتى أنزّلها ثم أنسخها مرة واحدة."
#
# So: a zip whose entries are REPO-RELATIVE PATHS, extractable straight over
# the project folder, with no wrapper directory and nothing to rearrange by
# hand.
#
# THE ONE THING A ZIP CANNOT DO is delete. If a change set removed files,
# extracting adds and replaces but leaves the removed ones behind — and a
# stale file that still compiles is the worst kind, because nothing announces
# it. So this script always writes a `_DELIVERY/` folder into the archive
# holding:
#
#   MANIFEST.txt   every path in this delivery, with its status
#   DELETE.ps1     the removals, as one paste-able PowerShell command
#   DELETE.sh      the same for macOS/Linux
#
# `_DELIVERY/` sits beside the real paths; it is documentation, not source,
# and deleting it after use costs nothing.
#
# USAGE
#   scripts/make-delivery-zip.sh <git-range> [output.zip]
#
#   scripts/make-delivery-zip.sh HEAD~1..HEAD          # the last commit
#   scripts/make-delivery-zip.sh main..HEAD            # everything on a branch
#   scripts/make-delivery-zip.sh abc1234..def5678 x.zip
#
# For a FULL tree instead of a delta, do not use this — use:
#   git archive --format=zip -9 -o FamilyOS-code.zip HEAD
# =============================================================================
set -euo pipefail

RANGE="${1:-}"
OUT="${2:-}"

if [ -z "$RANGE" ]; then
  echo "usage: $0 <git-range> [output.zip]" >&2
  echo "  e.g. $0 HEAD~1..HEAD" >&2
  exit 2
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

if ! git rev-parse --quiet --verify "${RANGE%%..*}" >/dev/null 2>&1; then
  echo "ERROR: '${RANGE%%..*}' is not a commit this repository knows." >&2
  exit 1
fi

# Default name carries the range, so two deliveries never overwrite each other
# in a Downloads folder.
if [ -z "$OUT" ]; then
  SHORT="$(git rev-parse --short "${RANGE##*..}")"
  OUT="ABNY-delta-${SHORT}.zip"
fi

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# --- what changed, split by what the receiving side must DO with it ----------
# A = added, M = modified, R = renamed (new name), C = copied  -> ship the file
# D = deleted, and the OLD name of a rename                    -> must be removed
CHANGED="$(git diff --name-only --diff-filter=ACMRT "$RANGE" || true)"
REMOVED="$(git diff --name-only --diff-filter=D "$RANGE" || true)"

# A rename removes its old path too. --diff-filter=D misses that, so ask again
# in a form that reports both sides.
RENAMED_OLD="$(git diff --name-status --diff-filter=R "$RANGE" | awk -F'\t' '{print $2}' || true)"
if [ -n "$RENAMED_OLD" ]; then
  REMOVED="$(printf '%s\n%s\n' "$REMOVED" "$RENAMED_OLD" | sed '/^$/d' | sort -u)"
fi

if [ -z "$CHANGED" ] && [ -z "$REMOVED" ]; then
  echo "Nothing changed in $RANGE — no delivery to make." >&2
  exit 1
fi

# --- copy each changed file to the stage AT ITS REPO PATH -------------------
COUNT=0
while IFS= read -r f; do
  [ -z "$f" ] && continue
  if [ ! -f "$f" ]; then
    echo "WARN: '$f' changed in range but is absent from the worktree; skipping." >&2
    continue
  fi
  mkdir -p "$STAGE/$(dirname "$f")"
  cp -p "$f" "$STAGE/$f"
  COUNT=$((COUNT + 1))
done <<< "$CHANGED"

mkdir -p "$STAGE/_DELIVERY"

# --- MANIFEST ---------------------------------------------------------------
{
  echo "ABNY — DELIVERY MANIFEST"
  echo "range   : $RANGE"
  echo "head    : $(git rev-parse HEAD)"
  echo "branch  : $(git rev-parse --abbrev-ref HEAD)"
  echo "files   : $COUNT changed, $(printf '%s\n' "$REMOVED" | grep -c . || true) to delete"
  echo
  echo "HOW TO APPLY"
  echo "  1. Run _DELIVERY/DELETE.ps1 (Windows) or DELETE.sh — ONLY if it lists files."
  echo "  2. Extract this zip over the project root. Choose Replace when asked."
  echo "     The paths inside are repo-relative: apps/... lands on apps/..."
  echo "  3. Delete the _DELIVERY folder. It is notes, not source."
  echo
  echo "CHANGED (extract these)"
  git diff --name-status --diff-filter=ACMRT "$RANGE" || true
  echo
  if [ -n "$(printf '%s' "$REMOVED" | sed '/^$/d')" ]; then
    echo "DELETED (a zip cannot remove these — run the DELETE script)"
    printf '%s\n' "$REMOVED" | sed '/^$/d'
  else
    echo "DELETED — none. Nothing to remove for this delivery."
  fi
  echo
  echo "COMMITS"
  git log --oneline "$RANGE" || true
} > "$STAGE/_DELIVERY/MANIFEST.txt"

# --- DELETE scripts ---------------------------------------------------------
CLEAN_REMOVED="$(printf '%s' "$REMOVED" | sed '/^$/d')"

{
  echo "# Removals for: $RANGE"
  echo "# Run from the project root BEFORE extracting the zip."
  if [ -z "$CLEAN_REMOVED" ]; then
    echo '"No files were deleted in this delivery. Nothing to do."'
  else
    echo '@('
    printf '%s\n' "$CLEAN_REMOVED" | sed 's|/|\\|g; s|^|  "|; s|$|",|' | sed '$ s|,$||'
    echo ') | ForEach-Object {'
    echo '  if (Test-Path $_) { Remove-Item $_ -Force; "removed : $_" }'
    echo '  else { "absent (fine) : $_" }'
    echo '}'
  fi
} > "$STAGE/_DELIVERY/DELETE.ps1"

{
  echo '#!/usr/bin/env bash'
  echo "# Removals for: $RANGE"
  echo '# Run from the project root BEFORE extracting the zip.'
  echo 'set -u'
  if [ -z "$CLEAN_REMOVED" ]; then
    echo 'echo "No files were deleted in this delivery. Nothing to do."'
  else
    echo 'for f in \'
    printf '%s\n' "$CLEAN_REMOVED" | sed 's|^|  "|; s|$|" \\|'
    echo '  ; do'
    echo '  if [ -f "$f" ]; then rm -f "$f"; echo "removed : $f"; else echo "absent (fine) : $f"; fi'
    echo 'done'
  fi
} > "$STAGE/_DELIVERY/DELETE.sh"
chmod +x "$STAGE/_DELIVERY/DELETE.sh"

# --- zip it -----------------------------------------------------------------
# `zip` writes relative to its own cwd, and we cd into the stage — so resolve
# the destination to an absolute path FIRST. An absolute -o was previously
# glued onto the repo root and produced `/repo//tmp/x.zip`.
case "$OUT" in
  /*) OUT_ABS="$OUT" ;;
   *) OUT_ABS="$REPO_ROOT/$OUT" ;;
esac
mkdir -p "$(dirname "$OUT_ABS")"
rm -f "$OUT_ABS"
( cd "$STAGE" && zip -q -r -9 "$OUT_ABS" . )

echo "wrote: $OUT_ABS"
echo "  changed : $COUNT"
echo "  deleted : $(printf '%s\n' "$CLEAN_REMOVED" | grep -c . || true)"
echo "  range   : $RANGE"
