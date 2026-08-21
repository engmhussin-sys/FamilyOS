#!/bin/sh
# ===========================================================================
# predeploy.sh — THE RELEASE STEP. Runs inside the production image, as
#                Railway's `preDeployCommand`, before any traffic.
#
# ========================== WHAT IT REPLACED, AND WHY ======================
#
# `preDeployCommand` was the single command `npx prisma migrate deploy`. On
# 2026-08-21 it produced this, over and over, on a container that had just
# been built and pushed perfectly:
#
#   29 migrations found in prisma/migrations
#   Error: P3005
#   The database schema is not empty.
#   Stopping Container
#
# A failing pre-deploy ABORTS THE PROMOTION: Railway keeps the previous
# deployment serving and the build tab stays green. Nine attempts, three days,
# and the running container never changed. The bare command had no way to say
# anything except "no".
#
# P3005 fires on one condition — TABLES PRESENT, `_prisma_migrations` MISSING
# OR EMPTY — which means no migration has ever been applied to that database
# through Prisma Migrate. Prisma cannot know which of the migrations those
# tables already represent, so it refuses to guess. That refusal is right.
# What was missing is the step that answers the question for it.
#
# ============================ WHAT THIS DOES INSTEAD =======================
#
#   1. `migrate deploy`. Succeeds on a healthy database — nothing below runs,
#      and the normal path is unchanged.
#   2. Any error that is NOT P3005 fails exactly as before, with its output.
#   3. On P3005, it MEASURES the live database TWICE, on two independent axes,
#      and only then decides:
#
#      a. TABLES AND COLUMNS — `prisma migrate diff` against schema.prisma.
#      b. THE MIGRATION SQL ITSELF — `scripts/predeploy-schema-probe.js`
#         counts `tenant_isolation` ROW LEVEL SECURITY policies.
#
#      (b) EXISTS BECAUSE (a) CANNOT SEE IT, AND THAT GAP IS A SECURITY ONE.
#      A database created by `prisma db push` has every table and every column
#      and NOT ONE POLICY — db push applies the datamodel, never the migration
#      SQL. `migrate diff` calls that "no drift". Baselining it would mark
#      migration 0004 (`tenant_rls_defence_in_depth`) as applied forever, and
#      the RLS layer beneath this product's tenant isolation would be silently
#      absent on a live host. Zero policies therefore REFUSES, whatever the
#      diff says.
#
#   4. Both clean → the baseline is a TRUE statement about that database, so
#      it is written (`migrate resolve --applied`, once per migration) and
#      `migrate deploy` is run again to prove the ledger is now complete.
#   5. Anything else → REFUSE, and print exactly what was measured. A refusal
#      that names the drift is worth nine silent ones.
#
# IT NEVER DROPS, ALTERS OR DELETES ANYTHING. The only write it can make is
# rows in `_prisma_migrations`, and only in case 4. Set
# `ABNY_PREDEPLOY_NO_BASELINE=1` to make even that a report instead.
#
# POSIX `sh`, NOT bash: this runs on the busybox shell in an Alpine image.
# No arrays, no `[[`, no `pipefail`.
# ===========================================================================
set -u

if [ -x ./node_modules/.bin/prisma ]; then
  PRISMA="${PRISMA_BIN:-./node_modules/.bin/prisma}"
else
  PRISMA="${PRISMA_BIN:-npx prisma}"
fi
PROBE="${PREDEPLOY_PROBE_BIN:-node scripts/predeploy-schema-probe.js}"

MIGRATIONS_DIR="${PREDEPLOY_MIGRATIONS_DIR:-prisma/migrations}"
SCHEMA_PATH="${PREDEPLOY_SCHEMA_PATH:-prisma/schema.prisma}"

say() { echo "[predeploy] $*"; }

say "=== ABNY RELEASE STEP ==================================================="

# --- 1. the normal path ----------------------------------------------------
DEPLOY_OUT="$(mktemp)"
# shellcheck disable=SC2086
$PRISMA migrate deploy > "$DEPLOY_OUT" 2>&1
DEPLOY_EXIT=$?
cat "$DEPLOY_OUT"

if [ "$DEPLOY_EXIT" -eq 0 ]; then
  say "migrate deploy succeeded. Nothing else to do."
  rm -f "$DEPLOY_OUT"
  exit 0
fi

# --- 2. anything that is not P3005 fails exactly as it did before ----------
if ! grep -q 'P3005' "$DEPLOY_OUT"; then
  say "migrate deploy failed with an error that is NOT P3005 (exit $DEPLOY_EXIT)."
  say "Its output is above, unmodified. This script changes nothing about that case."
  rm -f "$DEPLOY_OUT"
  exit "$DEPLOY_EXIT"
fi
rm -f "$DEPLOY_OUT"

say "------------------------------------------------------------------------"
say "P3005: this database has tables but no Prisma migration ledger."
say "No migration has ever been applied here through Prisma Migrate."
say "Measuring before deciding anything."
say "------------------------------------------------------------------------"

# --- 3a. did the migration SQL ever run here? ------------------------------
PROBE_OUT="$(mktemp)"
# shellcheck disable=SC2086
$PROBE > "$PROBE_OUT" 2>&1
PROBE_EXIT=$?
if [ "$PROBE_EXIT" -ne 0 ]; then
  say "BLOCKED: could not measure the live schema. The probe said:"
  cat "$PROBE_OUT"
  say "Nothing was written. A baseline decided without this measurement would be a guess."
  rm -f "$PROBE_OUT"
  exit 1
fi
say "probe: $(cat "$PROBE_OUT")"

POLICIES="$(sed -n 's/.*"tenantIsolationPolicies":\([0-9][0-9]*\).*/\1/p' "$PROBE_OUT")"
TABLES="$(sed -n 's/.*"baseTables":\([0-9][0-9]*\).*/\1/p' "$PROBE_OUT")"
# `null` (the table does not exist in this schema) deliberately does not match,
# and stays empty — "absent" is a different answer from "zero" and the line
# below says so rather than flattening both to 0.
FAMILIES="$(sed -n 's/.*"families":\([0-9][0-9]*\).*/\1/p' "$PROBE_OUT")"
USERS="$(sed -n 's/.*"users":\([0-9][0-9]*\).*/\1/p' "$PROBE_OUT")"
rm -f "$PROBE_OUT"

# THE LINE THAT DECIDES WHAT A HUMAN DOES NEXT. Every refusal below ends in
# the same question — "is there anything in this database worth keeping?" —
# and until this line existed the only way to answer it was to open a SQL
# console by hand. It is one query; it belongs in the log.
if [ -z "$FAMILIES" ] || [ -z "$USERS" ]; then
  say "contents: the families/users tables do not exist in this schema at all."
elif [ "$FAMILIES" -eq 0 ] && [ "$USERS" -eq 0 ]; then
  say "contents: 0 families, 0 users — THIS DATABASE HOLDS NO HOUSEHOLDS."
else
  say "contents: $FAMILIES families, $USERS users — THIS DATABASE HOLDS REAL DATA. Do not reset it."
fi

if [ -z "$POLICIES" ]; then
  say "BLOCKED: the probe produced no readable policy count. Refusing to baseline on an unreadable measurement."
  exit 1
fi

if [ "$POLICIES" -eq 0 ]; then
  cat <<'EOF'
[predeploy] ------------------------------------------------------------------
[predeploy] BLOCKED — THIS SCHEMA WAS NEVER BUILT BY THE MIGRATIONS.
[predeploy]
[predeploy] There is not one `tenant_isolation` row-level-security policy in
[predeploy] this database. Migration 0004 creates them, and five later
[predeploy] migrations extend them to new tables. Their absence means the
[predeploy] migration SQL has never run here — the tables came from
[predeploy] `prisma db push`, or from DDL applied by hand.
[predeploy]
[predeploy] Baselining now would mark 0004 as applied FOREVER, and the
[predeploy] row-level-security layer beneath this product's tenant isolation
[predeploy] would never be created on this host. Nothing would report it. The
[predeploy] application would work.
[predeploy]
[predeploy] So nothing was written. Two honest ways forward:
[predeploy]
[predeploy]   NO REAL DATA HERE (staging, scratch):
[predeploy]     DROP SCHEMA public CASCADE; CREATE SCHEMA public;
[predeploy]     then redeploy — `migrate deploy` builds it from empty, ledger
[predeploy]     and policies and all, and P3005 can never recur here.
[predeploy]
[predeploy]   REAL HOUSEHOLDS HERE (production):
[predeploy]     Do not reset and do not baseline. The migrations that were
[predeploy]     never run have to be applied deliberately, in order, with the
[predeploy]     data in place. Send this log for review.
[predeploy] ------------------------------------------------------------------
EOF
  exit 1
fi

say "the migration SQL HAS run here at some point ($POLICIES tenant_isolation policies, $TABLES base tables)."
say "so this is a migrated database whose ledger was lost, not a db-push schema."

# --- 3b. do the tables and columns match this build's schema? --------------
DRIFT="$(mktemp)"
# shellcheck disable=SC2086
$PRISMA migrate diff \
  --from-url "$DATABASE_URL" \
  --to-schema-datamodel "$SCHEMA_PATH" \
  --script --exit-code > "$DRIFT" 2>&1
DIFF_EXIT=$?

# `grep -v` exits 1 when it selects NOTHING — which is exactly the no-drift
# case — so its status is deliberately discarded here. An earlier sibling of
# this script failed on precisely the input that means "safe", and only ever
# completed when there WAS drift. Silent, and backwards. A test caught it.
STATEMENTS="$(grep -vE '^[[:space:]]*(--.*)?$' "$DRIFT" 2>/dev/null | wc -l | tr -d ' ')"
[ -z "$STATEMENTS" ] && STATEMENTS=0

say "migrate diff: exit $DIFF_EXIT, $STATEMENTS non-comment SQL lines"

if [ "$DIFF_EXIT" -ne 0 ] && [ "$DIFF_EXIT" -ne 2 ]; then
  say "BLOCKED: migrate diff could not run (exit $DIFF_EXIT). Its output:"
  cat "$DRIFT"
  say "Nothing was written."
  rm -f "$DRIFT"
  exit 1
fi

if [ "$DIFF_EXIT" -eq 0 ] && [ "$STATEMENTS" -ne 0 ]; then
  say "BLOCKED: the two signals disagree — exit code says no drift, the emitted script says drift."
  cat "$DRIFT"
  rm -f "$DRIFT"
  exit 1
fi
if [ "$DIFF_EXIT" -eq 2 ] && [ "$STATEMENTS" -eq 0 ]; then
  say "BLOCKED: the two signals disagree — exit code says drift, the emitted script is empty."
  rm -f "$DRIFT"
  exit 1
fi

if [ "$DIFF_EXIT" -eq 2 ]; then
  say "------------------------------------------------------------------------"
  say "BLOCKED — THE DATABASE DOES NOT MATCH THIS BUILD'S SCHEMA."
  say ""
  say "Baselining would record migrations as applied that are NOT in this"
  say "database. migrate deploy would then skip them permanently and this"
  say "build would run new code on an old schema: 200 on every route that"
  say "happens not to touch the missing column, 500 on the first one that does."
  say ""
  say "This is what the live database is MISSING. Nothing was written."
  say "--------------------------- DRIFT (not applied) ------------------------"
  cat "$DRIFT"
  say "------------------------------------------------------------------------"
  rm -f "$DRIFT"
  exit 1
fi
rm -f "$DRIFT"

# --- 4. both measurements clean: the baseline is true ----------------------
say "------------------------------------------------------------------------"
say "NO DRIFT, and the migration SQL has run here. Recording the migrations as"
say "applied is a true statement about this database, not a guess."

if [ "${ABNY_PREDEPLOY_NO_BASELINE:-0}" = "1" ]; then
  say "ABNY_PREDEPLOY_NO_BASELINE=1 — reporting instead of writing. Nothing was written."
  say "Unset it and redeploy to let the release step complete."
  exit 1
fi

COUNT=0
FAILED=0
for dir in "$MIGRATIONS_DIR"/*/; do
  [ -d "$dir" ] || continue
  name="$(basename "$dir")"
  COUNT=$((COUNT + 1))
  # shellcheck disable=SC2086
  if $PRISMA migrate resolve --applied "$name" >/dev/null 2>&1; then
    say "  marked applied : $name"
  else
    say "  FAILED         : $name"
    FAILED=$((FAILED + 1))
  fi
done

if [ "$COUNT" -eq 0 ]; then
  say "BLOCKED: no migration directories found under $MIGRATIONS_DIR. Refusing to baseline nothing."
  exit 1
fi
if [ "$FAILED" -ne 0 ]; then
  say "BLOCKED: $FAILED of $COUNT markers could not be written. The ledger is INCOMPLETE."
  say "Do not treat this deploy as successful."
  exit 1
fi

say "$COUNT migrations recorded as applied."

# --- 5. prove it, rather than assume it ------------------------------------
say "re-running migrate deploy against the ledger just written..."
# shellcheck disable=SC2086
$PRISMA migrate deploy
VERIFY_EXIT=$?
if [ "$VERIFY_EXIT" -ne 0 ]; then
  say "BLOCKED: migrate deploy still fails after baselining (exit $VERIFY_EXIT). Its output is above."
  exit "$VERIFY_EXIT"
fi

say "RELEASE STEP COMPLETE"
exit 0
