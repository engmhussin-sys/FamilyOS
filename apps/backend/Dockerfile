# Sprint 9: Production Docker Readiness — multi-stage build.
# Stage 1 (builder) has the full dev toolchain (TypeScript compiler,
# all devDependencies); Stage 2 (runtime) has ONLY what's needed to run
# the compiled output — smaller image, smaller attack surface, no
# TypeScript/test tooling shipped to production.

FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma
RUN npm ci

COPY . .
RUN npx prisma generate
RUN npm run build

# ---

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev && npx prisma generate

COPY --from=builder /app/dist ./dist

# Runs as a non-root user — a compromised Node process should not have
# root inside its own container, one more layer per Sprint 9's Security
# Hardening even though the container itself is already isolated.
RUN addgroup -S afdc && adduser -S afdc -G afdc
USER afdc

EXPOSE 3000

# Matches HealthController's /health/live \u2014 Docker's own healthcheck,
# independent of whatever the orchestrator (Railway, k8s) also configures.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health/live', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "dist/main.js"]
