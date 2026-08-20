# =============================================================================
# ABNY BACKEND — PRODUCTION IMAGE (NestJS + Prisma). Sprint 9's multi-stage
# build, corrected for a real deploy rather than a local `docker build`.
#
# BUILD CONTEXT IS THE REPOSITORY ROOT, not `apps/backend`:
#
#   docker build -f apps/backend/Dockerfile -t abny-backend .
#
# It changed for one reason. The deployment configuration (`railway.json`,
# `render.yaml`) lives at the repository root, both hosts resolve
# `dockerfilePath` from there, and a Dockerfile that only builds from a
# subdirectory forces every host into a per-service "root directory" setting
# that nothing in this repository can state, verify or review. One context,
# named in three files that all agree: this one, `docker-compose.yml` and
# `.github/workflows/ci.yml`. The root `.dockerignore` keeps the context
# small — the two Flutter apps, every build output and every node_modules are
# excluded.
#
# Stage 1 (builder) has the full dev toolchain (TypeScript compiler, Nest CLI,
# Prisma CLI, all devDependencies). Stage 2 (runtime) has the compiled output,
# the production dependencies, and nothing that can compile anything.
#
# NOT BUILT HERE. This file is STATIC VERIFIED only: the environment it was
# last edited in has no Docker daemon. Every COPY source was checked to exist
# at the path written. `.github/workflows/ci.yml` builds it on every push —
# that job, not this comment, is the proof.
#
# -----------------------------------------------------------------------------
# OBSERVED ON A REAL RAILWAY BUILD, 2026-08-20 — READ BEFORE "FIXING" A COPY
# -----------------------------------------------------------------------------
# A Railway build died with:
#
#     failed to compute cache key: "/apps/backend/src": not found
#
# The cause was NOT this file. The service's **Root Directory** was still
# `apps/backend`, left from an earlier deployment. With that setting Railway
# never reads the root `railway.json` at all — it auto-detects THIS file as a
# bare `Dockerfile`, builds with `apps/backend/` as the context, and every COPY
# above misses by exactly one path segment. The error names the symptom, not
# the cause.
#
# The fix is the Root Directory setting: set it to `/`. Do NOT rewrite the COPY
# paths to match a subdirectory context — that would break `railway.json`,
# `render.yaml`, `docker-compose.yml` and the CI build simultaneously, and the
# next person would face four broken things instead of one setting.
# =============================================================================

FROM node:20-alpine AS builder
WORKDIR /app

# FIXING A REAL, PERSISTENT DEPLOY FAILURE: specifying binaryTargets in
# schema.prisma alone did not resolve "Error loading shared library
# libssl.so.1.1: No such file or directory" — installing the actual
# missing shared library directly is the more direct, reliable fix.
# Tries the exact compat package first; falls back to whatever openssl
# this Alpine version's own repo provides.
RUN apk add --no-cache openssl1.1-compat || apk add --no-cache openssl

# Dependencies first, and only the files that decide them, so a source-only
# change does not re-run `npm ci`.
COPY apps/backend/package.json apps/backend/package-lock.json ./
COPY apps/backend/prisma ./prisma
RUN npm ci

# `argon2` is a native module and this is an Alpine (musl) image. It ships a
# musl prebuild — `prebuilds/linux-x64/argon2.musl.node`, verified inside the
# installed package — which is why no C toolchain is needed here. If that ever
# stops being true, the failure is loud, at build time, on this line.

# NOTE ON `prisma generate` AND THIS REPOSITORY'S SANDBOX. In the sandbox where
# this file was last edited, `npx prisma generate` is broken by an offline WASM
# shim. That is a property of that machine, not of Prisma and not of this
# image: the command below is correct for a real builder and is deliberately
# NOT worked around, because contorting a production Dockerfile around a
# sandbox limitation ships the workaround and loses the real behaviour.
RUN npx prisma generate

COPY apps/backend/tsconfig.json apps/backend/tsconfig.build.json apps/backend/nest-cli.json ./
COPY apps/backend/src ./src
RUN npm run build

# DIAGNOSTIC (added after a real "Cannot find module /app/dist/main.js"
# failure): prints the actual dist/ structure to the build log so this
# is provably correct rather than assumed. Harmless in a working build.
RUN echo "--- dist/ contents ---" && find dist -maxdepth 2 -type f

# -----------------------------------------------------------------------------

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Same direct fix as the builder stage — this is the stage that
# actually runs the app, so this is the one that matters most for the
# runtime error itself.
RUN apk add --no-cache openssl1.1-compat || apk add --no-cache openssl

COPY apps/backend/package.json apps/backend/package-lock.json ./
# The schema and the full migration history ship WITH the image on purpose:
# the release step that runs `prisma migrate deploy` runs FROM this image, so
# the migrations applied are always the ones that belong to the code being
# deployed. Migrations run from anywhere else are a second version of the
# truth.
COPY apps/backend/prisma ./prisma

# Production dependencies only. No TypeScript, no Nest CLI, no jest, no
# ts-node, no supertest — `--omit=dev` is what makes that sentence true, and
# `npm ci` (not `npm install`) is what makes it reproducible.
RUN npm ci --omit=dev

# THE ONE DELIBERATE EXCEPTION, AND WHY IT IS NOT "devDependencies in
# production". Four paths are copied from the builder instead of reinstalled:
#   * node_modules/.prisma      — the GENERATED client. It must be the client
#                                 generated from the schema in this image.
#   * node_modules/@prisma      — client runtime + query engine.
#   * node_modules/prisma       — the CLI, which `prisma migrate deploy` is.
#   * node_modules/.bin/prisma  — its entry point.
# Copying rather than `npx prisma@latest` at deploy time means the release step
# never reaches the network for a CLI, and never applies migrations with a CLI
# version other than the one the client was generated by. Nothing else from
# the builder's node_modules enters this image.
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder /app/node_modules/.bin/prisma ./node_modules/.bin/prisma

COPY --from=builder /app/dist ./dist

# -----------------------------------------------------------------------------
# THE BUILD STAMP. WHY IT EXISTS AND WHY IT IS THIS EXACT NAME.
#
# The live host was observed reporting `"commit": null` from
# GET /api/v1/system/diagnostics, which means nobody could tell which build was
# running — the single most useful fact while a deploy is in progress.
#
# THIS IS NOT A NEW MECHANISM. `SystemDiagnosticsController` already reads
# `process.env.GIT_COMMIT_SHA` and reports it, honestly, as `null` when it is
# absent (see its own comment, which anticipates exactly this build argument).
# Nothing in `apps/backend/src/` is touched to make this work; the frozen module
# already had the hook and nobody was passing the value.
#
# Declared in the RUNTIME stage, because that is the stage whose environment the
# running process actually sees. Default empty: an unstamped build must report
# `null` rather than a stale or invented sha.
#
# HOW EACH HOST SUPPLIES IT:
#   * `docker build --build-arg GIT_COMMIT_SHA=$(git rev-parse HEAD) ...`
#     — CI and any direct build. Baked into the image, so the image is
#     self-describing even if nothing sets it at runtime.
#   * Railway: `railway up` has no build-arg flag, so the deploy workflow sets
#     GIT_COMMIT_SHA as a SERVICE variable instead. That is a runtime env var,
#     it overrides the baked ENV below, and it arrives at the same
#     `process.env.GIT_COMMIT_SHA` lookup. One mechanism, two ways in.
#   * Render: set it in the service's environment, same effect.
# -----------------------------------------------------------------------------
ARG GIT_COMMIT_SHA=""
ENV GIT_COMMIT_SHA=$GIT_COMMIT_SHA

# Runs as a non-root user — a compromised Node process should not have
# root inside its own container, one more layer per Sprint 9's Security
# Hardening even though the container itself is already isolated.
RUN addgroup -S afdc && adduser -S afdc -G afdc && chown -R afdc:afdc /app
USER afdc

EXPOSE 3000

# Matches HealthController's /health/live. `health/live` and `health/ready`
# are the two routes EXCLUDED from the `api/v1` global prefix
# (src/common/http/global-pipeline.ts), so these paths are correct as written
# and do not move when the API version does.
#
# This is Docker's own healthcheck. The platform's probe is configured
# separately — railway.json / render.yaml point it at /health/ready, which
# also checks PostgreSQL and Redis.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health/live', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

# RESILIENT ENTRYPOINT (kept from the fix for a real deploy failure): nest
# build is expected to produce dist/main.js via tsconfig.build.json's rootDir,
# and this checks both possible shapes at container start rather than
# hardcoding one path and failing opaquely if the output structure differs.
#
# `exec` IS LOAD-BEARING AND WAS MISSING. Without it, `sh` stays PID 1 and
# never forwards SIGTERM to node, so `app.enableShutdownHooks()` (main.ts)
# never runs: the platform's graceful-shutdown window is spent waiting on a
# shell, and the process is then killed mid-request with Prisma connections
# open and the Outbox relay mid-tick. With `exec`, node IS PID 1 and receives
# the signal directly.
#
# MIGRATIONS ARE NOT RUN HERE. See railway.json / render.yaml and
# DEPLOY_STAGING.md §4 for where `prisma migrate deploy` runs and why it must
# not be in this line.
#
# `unset GIT_COMMIT_SHA` WHEN IT IS EMPTY, AND WHY THAT ONE WORD MATTERS.
# `ENV GIT_COMMIT_SHA=$GIT_COMMIT_SHA` above always DEFINES the variable — an
# unstamped build defines it as the EMPTY STRING, not as absent. The reader is
# `process.env.GIT_COMMIT_SHA ?? null`, and `??` only falls through on
# null/undefined, so an empty string would be reported verbatim: a build with
# no stamp would answer `"commit": ""` instead of `"commit": null`.
#
# That would be a quieter lie than the problem this stamp was added to fix —
# `null` says "nobody told me", `""` says "the sha is the empty string". So an
# empty value is unset here, at start, and the frozen controller keeps
# answering exactly `null` for an unstamped build. No file under
# `apps/backend/src/` is touched to achieve that.
CMD ["sh", "-c", "[ -n \"${GIT_COMMIT_SHA:-}\" ] || unset GIT_COMMIT_SHA; if [ -f dist/main.js ]; then exec node dist/main.js; else exec node dist/src/main.js; fi"]
