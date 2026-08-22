#!/usr/bin/env bash
# ===========================================================================
# seed-test-accounts.sh — CREATE A TEST HOUSEHOLD ON A DEPLOYED HOST,
#                         THROUGH THE REAL API, AND PRINT ITS CREDENTIALS.
#
# ========================= WHAT THIS DOES AND DOES NOT =====================
#
# It creates, over HTTP, exactly what a first-time family creates:
#
#   1. a parent account (registration creates the family and its OWNER)
#   2. two children on that family
#   3. a one-time pairing code for the first child's device
#
# THERE IS NO "SUPER ADMIN" ACCOUNT TO CREATE, AND THIS SCRIPT WILL NOT
# INVENT ONE. In this codebase `Role.SUPER_ADMIN` is not a user row: it is
# whoever holds `INTERNAL_ADMIN_API_KEY`, checked by `InternalAdminGuard` from
# an `x-internal-admin-key` header. It has no email and no password, it owns no
# family, and the guard deliberately does not write `request.user` — a platform
# operator has no tenant, and inventing one would put a false tenant on the
# request. So the operator "credential" is a key you set on the service and
# type into the dashboard's unlock screen at runtime.
#
# THERE IS NO SEPARATE "ADMIN" LOGIN EITHER. The admin dashboard authenticates
# with `POST /auth/login` using an ORDINARY PARENT ACCOUNT — the one below.
# Its family screens then show that family and no other, which is what the
# tenant-isolation proofs exist to guarantee.
#
# AND A CHILD HAS NO CREDENTIALS AT ALL. That is a product decision, not an
# omission: the child's device is paired, and the pairing code this script
# prints is what the child app consumes. A child cannot hold a password
# because a child must not be able to authenticate as anything.
#
# =========================== ABOUT THE PASSWORD ============================
#
# It is generated HERE, on your machine, or supplied by you in
# `ABNY_TEST_PASSWORD`. It is never transmitted anywhere except to the host you
# name, and it is printed to your terminal and written to a local file that
# `.gitignore` already excludes. Do not paste the output into a chat, an issue
# or a commit — the accounts are disposable, the habit is not.
#
# THIS IS FOR STAGING AND FOR A FRESH PRODUCTION YOU ARE TESTING. It registers
# a real account on whatever host you point it at; there is no undo.
#
# USAGE
#   scripts/seed-test-accounts.sh https://familyos-staging.up.railway.app
#   ABNY_TEST_PASSWORD='...' scripts/seed-test-accounts.sh https://host
# ===========================================================================
set -uo pipefail

BASE="${1:-}"
if [ -z "$BASE" ]; then
  echo "usage: $0 <base-url>" >&2
  exit 2
fi
BASE="${BASE%/}"
API="$BASE/api/v1"
OUT_FILE="${ABNY_TEST_OUT:-TEST-ACCOUNTS.txt}"

command -v curl >/dev/null 2>&1 || { echo "BLOCKED: curl is not installed." >&2; exit 1; }
command -v jq   >/dev/null 2>&1 || { echo "BLOCKED: jq is not installed — this script reads JSON responses." >&2; exit 1; }

# A stamp so repeated runs never collide on the unique email constraint, and
# so every account this script has ever made is identifiable at a glance.
STAMP="$(date +%Y%m%d-%H%M%S)"
EMAIL="${ABNY_TEST_EMAIL:-abny.test.$STAMP@example.com}"

# 16 bytes of urandom, hex-encoded, with a letter and a digit guaranteed by
# construction — the backend requires 10+ chars with at least one of each, and
# a generator that can produce an invalid password is a generator that will,
# on some run, at the worst time.
PASSWORD="${ABNY_TEST_PASSWORD:-}"
if [ -z "$PASSWORD" ]; then
  PASSWORD="Abny$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')1"
fi

post() { # post <path> <json> [bearer]
  if [ -n "${3:-}" ]; then
    curl -sS -m 30 -w '\n%{http_code}' -X POST "$API$1" \
      -H 'content-type: application/json' -H "authorization: Bearer $3" -d "$2"
  else
    curl -sS -m 30 -w '\n%{http_code}' -X POST "$API$1" \
      -H 'content-type: application/json' -d "$2"
  fi
}
body_of() { printf '%s' "$1" | sed '$d'; }
code_of() { printf '%s' "$1" | tail -1; }

fail() {
  echo
  echo "BLOCKED at: $1" >&2
  echo "HTTP $2" >&2
  echo "$3" >&2
  echo
  echo "Nothing further was created. Fix the above and run again — the email is" >&2
  echo "timestamped, so a retry never collides with this attempt." >&2
  exit 1
}

echo "=== ABNY TEST ACCOUNTS ==================================================="
echo "host   $BASE"
echo "email  $EMAIL"
echo "=========================================================================="

# --- 1. the parent, and with it the family ---------------------------------
R="$(post /auth/register "$(jq -nc --arg e "$EMAIL" --arg p "$PASSWORD" \
  '{email:$e,password:$p,fullName:"ABNY Test Parent",familyName:"ABNY Test Family",acceptedTerms:true,timezone:"Africa/Cairo",countryCode:"EG"}')")"
CODE="$(code_of "$R")"; BODY="$(body_of "$R")"
case "$CODE" in
  200|201) echo "created  parent account" ;;
  429) fail "POST /auth/register" "$CODE" "Rate limited — registration allows 5 per minute per IP. Wait a minute." ;;
  *)   fail "POST /auth/register" "$CODE" "$BODY" ;;
esac

# --- 2. a session, obtained the way a real client obtains one --------------
# `register` returns the PROFILE, not a session. The token comes from the real
# login flow, so this script exercises the same path the apps do rather than a
# shortcut that only it can take.
R="$(post /auth/login "$(jq -nc --arg e "$EMAIL" --arg p "$PASSWORD" '{email:$e,password:$p}')")"
CODE="$(code_of "$R")"; BODY="$(body_of "$R")"
[ "$CODE" = "200" ] || fail "POST /auth/login" "$CODE" "$BODY"
TOKEN="$(printf '%s' "$BODY" | jq -r '.tokens.accessToken // .accessToken // empty')"
[ -n "$TOKEN" ] || fail "POST /auth/login" "$CODE" "logged in, but no access token in the response: $BODY"
echo "created  session"

# --- 3. the children -------------------------------------------------------
#
# THE SECOND CHILD IS OPTIONAL, AND THAT IS THE PRODUCT SPEAKING, NOT A
# WEAKENED SCRIPT. A fresh family's plan allows ONE child; the second returns
# `403 PLAN_UPGRADE_REQUIRED`. An earlier draft of this script treated that as
# a failure and stopped after creating the first child — reporting a working
# paywall as a broken seeder, and leaving a half-seeded family behind. So the
# first child is required and the second is attempted: if the paywall answers,
# it is REPORTED as the product behaviour it is, and seeding continues.
FIRST_CHILD=""
SECOND_CHILD=""
PLAN_NOTE=""

add_child() { # add_child <first> <dob> <required:0|1>
  local r c b id
  r="$(post /children "$(jq -nc --arg f "$1" --arg d "$2" \
    '{firstName:$f,lastName:"Test",dateOfBirth:$d,gender:"unspecified"}')" "$TOKEN")"
  c="$(code_of "$r")"; b="$(body_of "$r")"

  if [ "$c" = "403" ] && printf '%s' "$b" | grep -q 'PLAN_UPGRADE_REQUIRED'; then
    if [ "$3" = "1" ]; then
      fail "POST /children ($1)" "$c" "The plan refused the FIRST child. That is not the paywall working — that is a broken entitlement. $b"
    fi
    echo "skipped  child $1 — the plan on a new family allows one child (403 PLAN_UPGRADE_REQUIRED)"
    PLAN_NOTE="the current plan allows ONE child; sibling scenarios need an upgraded plan"
    return 0
  fi

  case "$c" in
    200|201) ;;
    *) fail "POST /children ($1)" "$c" "$b" ;;
  esac
  id="$(printf '%s' "$b" | jq -r '.id // .childId // empty')"
  [ -n "$id" ] || fail "POST /children ($1)" "$c" "created, but no id in the response: $b"
  echo "created  child $1 ($id)"
  if [ -z "$FIRST_CHILD" ]; then FIRST_CHILD="$id"; else SECOND_CHILD="$id"; fi
}

add_child "Omar"  "2015-04-12" 1
add_child "Salma" "2018-09-30" 0

# --- 4. a pairing code for the child app -----------------------------------
R="$(post /pairing/invite "$(jq -nc --arg c "$FIRST_CHILD" '{childId:$c}')" "$TOKEN")"
CODE="$(code_of "$R")"; BODY="$(body_of "$R")"
[ "$CODE" = "200" ] || fail "POST /pairing/invite" "$CODE" "$BODY"
PAIR_CODE="$(printf '%s' "$BODY" | jq -r '.code // empty')"
PAIR_TTL="$(printf '%s' "$BODY" | jq -r '.expiresInSeconds // empty')"
echo "created  pairing code for Omar"

# --- the credentials -------------------------------------------------------
{
  echo "ABNY — TEST ACCOUNTS"
  echo "host    : $BASE"
  echo "created : $STAMP"
  echo
  echo "PARENT / ADMIN DASHBOARD LOGIN  (the dashboard has no separate admin account)"
  echo "  email    : $EMAIL"
  echo "  password : $PASSWORD"
  echo "  use for  : the dashboard sign-in page, and the parent mobile app"
  echo
  echo "CHILD APP PAIRING  (a child has no email and no password, by design)"
  echo "  child    : Omar (id $FIRST_CHILD)"
  echo "  code     : ${PAIR_CODE:-<none returned>}"
  echo "  expires  : ${PAIR_TTL:-?} seconds from creation — regenerate with POST /pairing/invite"
  if [ -n "$SECOND_CHILD" ]; then
    echo "  sibling  : Salma (id $SECOND_CHILD) — invite separately when you need a second device"
  fi
  if [ -n "$PLAN_NOTE" ]; then
    echo
    echo "PLAN LIMIT OBSERVED ON THIS HOST"
    echo "  $PLAN_NOTE."
    echo "  This is the paywall behaving correctly, not a seeding failure."
  fi
  echo
  echo "PLATFORM OPERATOR (\"super admin\")"
  echo "  There is no account. The operator surface is held by whoever knows"
  echo "  INTERNAL_ADMIN_API_KEY, sent as the x-internal-admin-key header and"
  echo "  typed into the dashboard's unlock screen at runtime. Set that variable"
  echo "  on the backend service; it is never a row in the users table and is"
  echo "  deliberately not created by this script."
} | tee "$OUT_FILE"

echo
echo "written to $OUT_FILE — it is git-ignored. Do not paste it into a chat or a commit."
echo "TEST ACCOUNTS READY"
