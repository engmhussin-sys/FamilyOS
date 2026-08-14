#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Regenerates Prisma Client in an environment where binaries.prisma.sh is
# blocked (this repo's CI and any normal machine can just run
# `npx prisma generate` — do NOT use this script there).
#
# Two problems, two workarounds:
#
# 1. `prisma generate` tries to download the native query engine and dies on
#    403. PRISMA_QUERY_ENGINE_LIBRARY / PRISMA_*_BINARY short-circuit engine
#    RESOLUTION to a local placeholder file, so nothing is downloaded.
#    NOTE: unlike F1's script this deliberately does NOT pass `--no-engine`.
#    `--no-engine` produces an Accelerate-only client that refuses the
#    `adapter` option, which is exactly what we need here.
#
# 2. The generated client can then run on the WASM query engine that ships
#    inside @prisma/client, driven by @prisma/adapter-pg over node-postgres.
#    Its two loader stubs assume a bundler (`import('./query_engine_bg.wasm')`),
#    which plain Node cannot resolve. The two files written below replace the
#    stubs with a filesystem read + WebAssembly.compile.
#
# After this script, `PrismaClient` from '@prisma/client/wasm' constructed with
# `{ adapter: new PrismaPg(pool) }` talks to a real PostgreSQL server.
# ---------------------------------------------------------------------------
set -euo pipefail
cd "$(dirname "$0")/.."
touch /tmp/fake_query_engine.so.node
PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING=1 \
PRISMA_QUERY_ENGINE_LIBRARY=/tmp/fake_query_engine.so.node \
PRISMA_QUERY_ENGINE_BINARY=/tmp/fake_query_engine.so.node \
PRISMA_SCHEMA_ENGINE_BINARY=/tmp/fake_query_engine.so.node \
DATABASE_URL="${DATABASE_URL:-postgresql://localhost:5432/placeholder}" \
  npx prisma generate

CLIENT_DIR="node_modules/.prisma/client"

# The wasm glue module the engine's JS bindings live in.
cat > "$CLIENT_DIR/query_engine_bg.js" <<'GLUE'
// Written by scripts/regen-prisma-client-offline.sh — see that file.
module.exports = require('@prisma/client/runtime/query_engine_bg.postgresql.js');
GLUE

# The compiled WebAssembly.Module itself. Loaded SYNCHRONOUSLY and via CommonJS
# on purpose: the generated stub uses `await import('./query_engine_bg.wasm')`,
# which Jest's CJS VM rejects outright with
# "A dynamic import callback was invoked without --experimental-vm-modules".
cat > "$CLIENT_DIR/query_engine_wasm_module.js" <<'WASMMOD'
// Written by scripts/regen-prisma-client-offline.sh — see that file.
const fs = require('fs');
const wasmPath = require.resolve('@prisma/client/runtime/query_engine_bg.postgresql.wasm');
module.exports = new WebAssembly.Module(fs.readFileSync(wasmPath));
WASMMOD

# Point the generated client at the two files above.
node - "$CLIENT_DIR/wasm.js" <<'PATCH'
const fs = require('fs');
const file = process.argv[2];
let s = fs.readFileSync(file, 'utf8');
s = s.replace(
  /getQueryEngineWasmModule: async \(\) => \{[\s\S]*?\n  \}/,
  'getQueryEngineWasmModule: async () => require(\'./query_engine_wasm_module.js\')',
);
fs.writeFileSync(file, s);
PATCH
echo "Prisma Client regenerated with the offline WASM engine shims."
