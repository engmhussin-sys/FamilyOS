#!/usr/bin/env bash
# ===========================================================================
# deploy-doctor.sh — WHICH BUILD IS SERVING THIS URL, AND ON WHICH SCHEMA?
#
# THE QUESTION IT ANSWERS. A green "Deployed" badge means an image was pushed.
# It does not mean the container booted, it does not mean this branch's code is
# the code answering, and it does not mean `prisma migrate deploy` ran. On
# 2026-08-21 this project had all three doubts at once: a first successful image
# build, and a staging host that answered `GET /health/ready` with
# `{"status":"ok","database":true,"redis":true}` while still serving a build
# from before the operator surface was closed. `/health/ready` asks whether
# Postgres answers `SELECT 1` — a schema thirty migrations behind answers that
# exactly as cheerfully as today's.
#
# WHAT IT IS. One read-only pass over a deployed HTTP host. It deploys nothing,
# changes nothing, and writes nothing anywhere. Every check prints exactly one
# of PASS / WARN / BLOCKED and, when it is not PASS, one actionable line.
#
#   PASS     the requirement is met AND MEASURED on the live host.
#   WARN     a real gap that does not make the deploy wrong, or a requirement
#            this run could not measure and refuses to claim.
#   BLOCKED  what is deployed is not what you think is deployed.
#
# THE ONE CHECK THAT CANNOT BE FAKED. `GET /api/v1/system/diagnostics` is behind
# `InternalAdminGuard` in this codebase and was ANONYMOUS before it. So an
# unauthenticated call is a build fingerprint that needs no key and no access to
# the platform console:
#
#   401  → a build WITH the guard. Current code.
#   200  → a build WITHOUT it. Old code, and the operator console is open to
#          the internet right now.
#   500/503 → also a build without it: the route answered and its handler
#          decided the status. A guarded route never reaches its handler.
#   404  → wrong host, wrong prefix, or a build older than the route itself.
#
# WHERE THE EXPECTED VALUES COME FROM. The repository, at run time: the newest
# directory under apps/backend/prisma/migrations, and `git rev-parse HEAD`.
# Nothing in this file is a number typed from memory, so the expectations move
# when the repository moves — the only way a doctor stays honest over time.
#
# NO FALSE PASSES. A check that "passes" because curl could not resolve the
# host, because a variable was unset, or because a grep found nothing is worse
# than no check at all. Every branch below was walked for that failure mode;
# where a fact genuinely cannot be measured without the operator key, the row
# says NOT VERIFIED and grades WARN. It never says PASS.
#
# USAGE
#   scripts/deploy-doctor.sh <base-url> [--key <operator-key>]
#
#   scripts/deploy-doctor.sh https://familyos-staging.up.railway.app
#   scripts/deploy-doctor.sh https://host --key "$INTERNAL_ADMIN_API_KEY"
#
# THE KEY IS NEVER PRINTED, never logged and never written to a file. Prefer
#   scripts/deploy-doctor.sh https://host --key "$INTERNAL_ADMIN_API_KEY"
# over pasting the literal, so it does not enter your shell history.
# ===========================================================================
set -uo pipefail

BASE="${1:-}"
shift || true
KEY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --key) KEY="${2:-}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$BASE" ]; then
  echo "usage: $0 <base-url> [--key <operator-key>]" >&2
  exit 2
fi
BASE="${BASE%/}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BLOCKED=0
WARNED=0

row() { printf '%-8s %-34s %s\n' "$1" "$2" "$3"; }
pass() { row PASS "$1" "$2"; }
warn() { row WARN "$1" "$2"; WARNED=$((WARNED + 1)); }
block() { row BLOCKED "$1" "$2"; BLOCKED=$((BLOCKED + 1)); }

# `-o body -w code` in one call: two calls could hit two different replicas and
# report a status that never belonged to the body printed beside it.
http() { # http <path> [header]
  local path="$1" hdr="${2:-}" tmp code
  tmp="$(mktemp)"
  if [ -n "$hdr" ]; then
    code="$(curl -sS -m 20 -o "$tmp" -w '%{http_code}' -H "$hdr" "$BASE$path" 2>/dev/null)"
  else
    code="$(curl -sS -m 20 -o "$tmp" -w '%{http_code}' "$BASE$path" 2>/dev/null)"
  fi
  # A curl failure leaves `code` empty or 000. It is returned as-is rather than
  # defaulted to something plausible: "could not reach it" must never be
  # indistinguishable from a real status.
  printf '%s\n' "${code:-000}"
  cat "$tmp"
  rm -f "$tmp"
}

json_field() { # json_field <body> <jq-path>  — empty when jq is absent
  command -v jq >/dev/null 2>&1 || return 1
  printf '%s' "$1" | jq -r "$2" 2>/dev/null
}

echo "=== ABNY DEPLOY DOCTOR ==================================================="
echo "host   $BASE"
echo "repo   $REPO_ROOT"
echo "key    $([ -n "$KEY" ] && echo 'supplied (never printed)' || echo 'not supplied — build identity will be NOT VERIFIED')"
echo "=========================================================================="

command -v curl >/dev/null 2>&1 || { block toolchain "curl is not installed. Install curl, or run scripts/deploy-doctor.ps1 on Windows."; echo; echo "DO NOT SHIP"; exit 1; }
command -v jq   >/dev/null 2>&1 || warn toolchain "jq is not installed — response bodies are printed raw instead of parsed. Install jq for the field-by-field checks."

# --- 1. the process ---------------------------------------------------------
OUT="$(http /health/live)"; CODE="$(printf '%s' "$OUT" | head -1)"; BODY="$(printf '%s' "$OUT" | tail -n +2)"
case "$CODE" in
  200) pass liveness "the process is up and answering" ;;
  000) block liveness "could not reach $BASE at all — check the host name, and that the service is not asleep" ;;
  *)   block liveness "GET /health/live returned $CODE, not 200 — the container is not serving" ;;
esac

# --- 2. its two hard dependencies -------------------------------------------
OUT="$(http /health/ready)"; CODE="$(printf '%s' "$OUT" | head -1)"; BODY="$(printf '%s' "$OUT" | tail -n +2)"
DB="$(json_field "$BODY" '.database')"; RD="$(json_field "$BODY" '.redis')"
if [ "$CODE" = "200" ]; then
  pass readiness "Postgres and Redis both reachable ${DB:+(database=$DB redis=$RD)}"
elif [ "$CODE" = "503" ]; then
  block readiness "degraded: database=${DB:-?} redis=${RD:-?} — a false value names the dependency to fix"
else
  block readiness "GET /health/ready returned $CODE — expected 200 or 503"
fi

# --- 3. WHICH BUILD (needs no key) ------------------------------------------
OUT="$(http /api/v1/system/diagnostics)"; CODE="$(printf '%s' "$OUT" | head -1)"
case "$CODE" in
  401)
    pass build-identity "the operator surface is CLOSED — this host is running current code"
    ;;
  200)
    block build-identity "OLD BUILD, AND EXPOSED: /api/v1/system/diagnostics answered an anonymous caller with the build, the environment and every feature flag. Redeploy this service from the current branch."
    ;;
  500|503)
    block build-identity "OLD BUILD: the route answered ($CODE) instead of refusing. A guarded route never reaches its handler, so this host predates the guard. Redeploy this service from the current branch."
    ;;
  404)
    block build-identity "no /api/v1/system/diagnostics here — wrong host, wrong global prefix, or a build older than the route. Confirm the service and its branch."
    ;;
  000)
    block build-identity "unreachable — see the liveness row above"
    ;;
  *)
    warn build-identity "unexpected status $CODE — cannot classify this build; read the body by hand"
    ;;
esac

# --- 4. WHAT it is, and WHICH SCHEMA (needs the key) ------------------------
EXPECTED_MIGRATION="$(ls -1 "$REPO_ROOT/apps/backend/prisma/migrations" 2>/dev/null | sort | tail -1)"
EXPECTED_COUNT="$(ls -1d "$REPO_ROOT"/apps/backend/prisma/migrations/*/ 2>/dev/null | wc -l | tr -d ' ')"
EXPECTED_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null)"

if [ -z "$KEY" ]; then
  warn build-commit    "NOT VERIFIED — pass --key to read the deployed commit"
  warn schema-version  "NOT VERIFIED — pass --key to read the applied migrations"
else
  OUT="$(http /api/v1/system/diagnostics "x-internal-admin-key: $KEY")"
  CODE="$(printf '%s' "$OUT" | head -1)"; BODY="$(printf '%s' "$OUT" | tail -n +2)"
  if [ "$CODE" = "401" ]; then
    block operator-key "the key was refused. Either it is wrong, or INTERNAL_ADMIN_API_KEY is unset on this service — in which case the guard is failing closed and NO operator can read diagnostics."
  elif [ "$CODE" != "200" ]; then
    block operator-key "diagnostics returned $CODE with a key — expected 200"
  else
    COMMIT="$(json_field "$BODY" '.commit')"
    ENVIRONMENT="$(json_field "$BODY" '.environment')"
    AVAILABLE="$(json_field "$BODY" '.schema.available')"
    APPLIED="$(json_field "$BODY" '.schema.appliedCount')"
    LATEST="$(json_field "$BODY" '.schema.latestName')"
    BROKEN="$(json_field "$BODY" '.schema.unfinishedCount')"

    pass environment "the deployed process calls itself '${ENVIRONMENT:-?}'"
    if [ -z "$COMMIT" ] || [ "$COMMIT" = "null" ]; then
      warn build-commit "the deployed build reports no commit — set GIT_COMMIT_SHA as a build arg so a deploy can be traced to a commit"
    elif [ "$COMMIT" = "$EXPECTED_SHA" ]; then
      pass build-commit "deployed commit is this working tree's HEAD (${COMMIT:0:12})"
    else
      warn build-commit "deployed ${COMMIT:0:12}, local HEAD ${EXPECTED_SHA:0:12} — expected if you have committed since deploying; BLOCKED if you have not"
    fi

    if [ -z "$AVAILABLE" ]; then
      warn schema-version "this build's diagnostics has no 'schema' field — it predates MigrationStatusService. Redeploy to measure the applied migrations."
    elif [ "$AVAILABLE" != "true" ]; then
      block schema-version "the deployed database has no readable _prisma_migrations table. 'prisma migrate deploy' has never run against it — the preDeployCommand is not doing what railway.json says."
    elif [ "${BROKEN:-0}" != "0" ]; then
      block schema-version "$BROKEN migration(s) started and never finished, or were rolled back. The schema is HALF-migrated: $(json_field "$BODY" '.schema.unfinishedNames|join(", ")')"
    elif [ "$LATEST" = "$EXPECTED_MIGRATION" ] && [ "$APPLIED" = "$EXPECTED_COUNT" ]; then
      pass schema-version "$APPLIED migrations applied, latest $LATEST — matches this repository exactly"
    else
      block schema-version "deployed schema is at $APPLIED/$EXPECTED_COUNT (latest '$LATEST', repository has '$EXPECTED_MIGRATION'). The container is running new code on an old schema."
    fi
  fi
fi

echo "=========================================================================="
if [ "$BLOCKED" -gt 0 ]; then
  echo "$BLOCKED blocked, $WARNED warned."
  echo "DO NOT SHIP"
  exit 1
fi
echo "0 blocked, $WARNED warned."
echo "DEPLOY VERIFIED"
exit 0
