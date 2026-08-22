#!/usr/bin/env bash
# ===========================================================================
# db-baseline.sh — TEACH PRISMA ABOUT A DATABASE THAT ALREADY HAS TABLES,
#                  AND REFUSE TO DO IT WHEN THAT WOULD BE A LIE.
#
# ============================== WHAT HAPPENED ==============================
#
# 2026-08-21 08:22, Railway deploy log, on a container that had just been
# built and pushed perfectly:
#
#   Prisma schema loaded from prisma/schema.prisma
#   29 migrations found in prisma/migrations
#   Error: P3005
#   The database schema is not empty.
#   Stopping Container
#
# `preDeployCommand` failed, so Railway ABORTED THE PROMOTION and left the
# previous deployment serving. Two images built that day; neither ever ran.
# The build tab stayed green throughout.
#
# P3005 fires on exactly one condition: the schema has tables AND
# `_prisma_migrations` is missing or empty. That combination means NO
# migration has ever been applied to this database through Prisma Migrate —
# its tables came from `prisma db push`, or from SQL run by hand. Prisma
# cannot know which of the 29 migrations those tables already represent, so
# it refuses rather than guess. That refusal is correct.
#
# ======================== WHAT BASELINING ACTUALLY IS ======================
#
# Writing rows into `_prisma_migrations` that say "this migration is already
# applied" WITHOUT running its SQL. It is a CLAIM ABOUT THE DATABASE, and a
# false claim here is the most expensive mistake available in this whole
# deploy: baseline a database that is missing migration 0030's columns, and
# `migrate deploy` will skip 0030 forever. The application then runs new code
# against an old schema and answers 200 on every route that happens not to
# touch the new column — until one does, in production, later.
#
# SO THIS SCRIPT MEASURES BEFORE IT CLAIMS. `prisma migrate diff` compares
# the LIVE database against `schema.prisma` and emits the SQL that would be
# needed to close the gap.
#
#   no gap    the database already matches this branch's schema. Baselining
#             is then true, and it is done: 29 `migrate resolve --applied`.
#   any gap   REFUSED. The drift is printed in full and nothing is written.
#             A human decides, with the SQL in front of them.
#
# THE TWO SIGNALS MUST AGREE. `--exit-code` and the emitted script are read
# INDEPENDENTLY, and if they disagree the script refuses. A doctor that
# trusts one channel is one Prisma release away from a silent false green,
# and this repository has already shipped a doctor that was confidently
# wrong.
#
# READ-ONLY UNTIL IT IS NOT. Everything up to the decision touches nothing.
# `--apply` is required to write even the ledger rows; without it this is a
# pure diagnosis and prints the commands it would have run.
#
# USAGE
#   scripts/db-baseline.sh                 # diagnose only, writes nothing
#   scripts/db-baseline.sh --apply         # baseline, if and only if no drift
#
#   DATABASE_URL must point at the database to baseline, and must be
#   REACHABLE FROM HERE. Railway's `postgres.railway.internal` host only
#   resolves inside Railway — use the PUBLIC connection string from the
#   Postgres service's Connect tab when running this from your own machine.
#
# THE URL IS NEVER PRINTED. It carries a password. Only the database name and
# host are echoed, and only when they can be parsed safely.
# ===========================================================================
set -uo pipefail

APPLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    -h|--help) sed -n '2,60p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

# Overridable so the decision logic can be exercised without a live database
# and without Prisma's migration engine — see
# apps/backend/test/deploy/db-baseline.spec.ts. It defaults to the real thing;
# a test must opt in, never the other way round.
PRISMA="${PRISMA_BIN:-npx prisma}"

BACKEND_DIR="${DB_BASELINE_BACKEND_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../apps/backend" 2>/dev/null && pwd)}"
if [ -z "$BACKEND_DIR" ] || [ ! -d "$BACKEND_DIR/prisma/migrations" ]; then
  echo "BLOCKED: cannot find apps/backend/prisma/migrations. Run this from inside the repository." >&2
  exit 1
fi

if [ -z "${DATABASE_URL:-}" ]; then
  cat >&2 <<'EOF'
BLOCKED: DATABASE_URL is not set.

Set it to the database you intend to baseline, using the PUBLIC connection
string from Railway (Postgres service -> Connect). The internal host
`postgres.railway.internal` does not resolve outside Railway.

  export DATABASE_URL='postgresql://...@...proxy.rlwy.net:PORT/railway'
EOF
  exit 1
fi

echo "=== ABNY DB BASELINE ====================================================="
echo "backend  $BACKEND_DIR"
echo "target   $(printf '%s' "$DATABASE_URL" | sed -E 's#^([a-z+]+)://[^@]*@#\1://<credentials-hidden>@#')"
echo "mode     $([ "$APPLY" = 1 ] && echo 'APPLY — will write _prisma_migrations rows if there is no drift' || echo 'DIAGNOSE ONLY — writes nothing')"
echo "=========================================================================="

MIGRATIONS=()
while IFS= read -r name; do
  [ -n "$name" ] && MIGRATIONS+=("$name")
done < <(ls -1 "$BACKEND_DIR/prisma/migrations" 2>/dev/null | sort)

if [ "${#MIGRATIONS[@]}" -eq 0 ]; then
  echo "BLOCKED: no migration directories found. Refusing to baseline nothing." >&2
  exit 1
fi
echo "migrations in this branch : ${#MIGRATIONS[@]}  (newest: ${MIGRATIONS[${#MIGRATIONS[@]}-1]})"

# --- the measurement -------------------------------------------------------
DRIFT_FILE="$(mktemp)"
trap 'rm -f "$DRIFT_FILE"' EXIT

# shellcheck disable=SC2086
(cd "$BACKEND_DIR" && $PRISMA migrate diff \
  --from-url "$DATABASE_URL" \
  --to-schema-datamodel prisma/schema.prisma \
  --script --exit-code) > "$DRIFT_FILE" 2>&1
DIFF_EXIT=$?

# Prisma prints a comment line for an empty diff. Rather than matching that
# exact sentence — which is a string in someone else's release notes — the
# emitted script is judged by whether it contains any line that is not blank
# and not a comment. That test survives a reworded message.
#
# `|| true` IS LEAD, NOT DECORATION, and it was put here by a failing test.
# `grep -v` exits 1 when it selects NOTHING — which is precisely the
# no-drift case — and with `pipefail` that made the assignment fail. An
# earlier draft also ran `set -e` around this block, so the script exited 1
# on exactly the input that means "safe to baseline", and only ever completed
# when there WAS drift. Silent, and backwards.
STATEMENTS="$( { grep -vE '^\s*(--.*)?$' "$DRIFT_FILE" || true; } | wc -l | tr -d ' ')"

echo "diff exit code            : $DIFF_EXIT   (0 = no drift, 2 = drift)"
echo "non-comment SQL lines     : $STATEMENTS"

if [ "$DIFF_EXIT" -ne 0 ] && [ "$DIFF_EXIT" -ne 2 ]; then
  echo
  echo "BLOCKED: prisma migrate diff failed to run. Its output:" >&2
  cat "$DRIFT_FILE" >&2
  echo
  echo "Nothing was written. Fix the connection or the toolchain and run again." >&2
  exit 1
fi

CODE_SAYS_CLEAN=$([ "$DIFF_EXIT" -eq 0 ] && echo 1 || echo 0)
SCRIPT_SAYS_CLEAN=$([ "$STATEMENTS" -eq 0 ] && echo 1 || echo 0)

if [ "$CODE_SAYS_CLEAN" != "$SCRIPT_SAYS_CLEAN" ]; then
  echo
  echo "BLOCKED: the two signals disagree — exit code says $([ "$CODE_SAYS_CLEAN" = 1 ] && echo 'no drift' || echo 'drift'), the emitted script says $([ "$SCRIPT_SAYS_CLEAN" = 1 ] && echo 'no drift' || echo 'drift')." >&2
  echo "Refusing to baseline on an ambiguous measurement. The emitted script:" >&2
  echo "--------------------------------------------------------------------" >&2
  cat "$DRIFT_FILE" >&2
  exit 1
fi

# --- drift: refuse, and show the operator exactly what it is ---------------
if [ "$CODE_SAYS_CLEAN" = 0 ]; then
  cat <<'EOF'

BLOCKED — THE DATABASE DOES NOT MATCH THIS BRANCH'S SCHEMA.

Baselining now would record migrations as applied that are NOT in this
database. `migrate deploy` would then skip them permanently, and the
application would run new code on an old schema — a fault that shows up as a
200 on every route that happens not to touch the missing column, and as a
500 on the first one that does.

The SQL below is what the live database is MISSING relative to
prisma/schema.prisma. Nothing has been written.

--------------------------- DRIFT (not applied) ---------------------------
EOF
  cat "$DRIFT_FILE"
  cat <<'EOF'
---------------------------------------------------------------------------

TWO HONEST WAYS FORWARD, and which one is right depends on ONE question:
does this database hold real data you cannot lose?

  NO  (staging, a scratch environment)
      Drop and recreate the schema, then let `migrate deploy` build it from
      empty — the path that is proven: 29 migrations, 101 tables, and a
      ledger Prisma wrote itself, so P3005 can never recur here.

  YES (production, or anything with real households in it)
      Do NOT reset, and do NOT baseline. Send this drift for review first.
      The subset of migrations already represented in the schema has to be
      established migration by migration; only that subset may be resolved
      as applied, and the rest must actually run.

EOF
  exit 1
fi

# --- no drift: baselining is true ------------------------------------------
cat <<EOF

NO DRIFT. The live database already matches prisma/schema.prisma, so
recording all ${#MIGRATIONS[@]} migrations as applied is a TRUE statement
about it, not a guess.

EOF

if [ "$APPLY" = 0 ]; then
  echo "DIAGNOSE ONLY — nothing was written. These are the commands --apply would run:"
  for name in "${MIGRATIONS[@]}"; do
    echo "  npx prisma migrate resolve --applied $name"
  done
  echo
  echo "Re-run with --apply to write them."
  echo "SAFE TO BASELINE"
  exit 0
fi

FAILED=0
for name in "${MIGRATIONS[@]}"; do
  # shellcheck disable=SC2086
  if (cd "$BACKEND_DIR" && $PRISMA migrate resolve --applied "$name") >/dev/null 2>&1; then
    echo "  applied-marker written : $name"
  else
    echo "  FAILED                 : $name" >&2
    FAILED=$((FAILED + 1))
  fi
done

echo "=========================================================================="
if [ "$FAILED" -gt 0 ]; then
  echo "$FAILED of ${#MIGRATIONS[@]} markers could not be written. The ledger is INCOMPLETE —" >&2
  echo "do not deploy until every migration above is accounted for." >&2
  exit 1
fi

cat <<EOF
All ${#MIGRATIONS[@]} migrations are now recorded as applied.

Redeploy. \`prisma migrate deploy\` will find a complete ledger, apply
nothing, and the container will start. Then confirm with the deploy doctor —
its schema-version row reads the same ledger back out of the running host:

  scripts/deploy-doctor.sh https://<host> --key "\$INTERNAL_ADMIN_API_KEY"
EOF
echo "BASELINE COMPLETE"
exit 0
