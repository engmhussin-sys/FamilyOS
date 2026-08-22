#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Regenerates Prisma Client where `binaries.prisma.sh` is unreachable (this
# repo's build environments answer 403). A normal machine can just run
# `npx prisma generate`.
#
# THIS SCRIPT USED TO BE FOUR TIMES THIS LENGTH. Prisma 5 needed a native QUERY
# ENGINE, so generating offline meant downloading nothing, then hand-writing
# three shim files to drive the WASM engine through @prisma/adapter-pg, then
# patching the generated client to load them synchronously because Jest's CJS
# VM rejects `await import('./query_engine_bg.wasm')`.
#
# PRISMA 7 DELETED THE QUERY ENGINE. Driver adapters are the default and the
# client talks to PostgreSQL through `pg`, which is plain JavaScript. Every one
# of those shims is gone, and so is the production failure that came with the
# binary — an engine built for openssl-1.1.x refusing to load inside
# node:20-alpine, which is why `binaryTargets` existed in the schema.
#
# WHAT REMAINS is one narrow workaround: `prisma generate` still resolves the
# SCHEMA engine (the binary behind `migrate` and `validate`) even when it is not
# going to run it. The env vars below point that resolution at a placeholder
# file so nothing is downloaded. Migrations themselves still need the real
# schema engine and therefore a machine that can reach the CDN.
# ---------------------------------------------------------------------------
set -euo pipefail
cd "$(dirname "$0")/.."

PLACEHOLDER="$(mktemp)"

PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING=1 \
PRISMA_SCHEMA_ENGINE_BINARY="$PLACEHOLDER" \
DATABASE_URL="${DATABASE_URL:-postgresql://localhost:5432/placeholder}" \
  npx prisma generate

rm -f "$PLACEHOLDER"
echo "Prisma Client regenerated. No engine binary was downloaded, and none is needed at runtime."
