import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import compression from 'compression';
import * as Sentry from '@sentry/node';

import { AppModule } from './app.module';
import { applyGlobalHttpPipeline } from './common/http/global-pipeline';
import { configureTrustProxy } from './common/http/trust-proxy';
import { OutboxRelay } from './modules/events/application/outbox.relay';

/**
 * Sprint 4 (Observability) — CLOSES A REAL GAP: before this, a real
 * production 5xx error was invisible to the team except by manually
 * tailing Railway's own logs. No structured error tracking existed.
 *
 * HONEST LIMITATION, STATED PLAINLY: without a real `SENTRY_DSN`
 * environment variable set, `Sentry.init` runs in a safe no-op mode
 * (Sentry's own documented behavior for a missing/empty DSN) — this
 * backend behaves exactly as it did before this sprint, not broken,
 * just not yet reporting. A real Sentry project (a real external
 * account this environment cannot create) must be set up, and its
 * DSN added as a Railway environment variable, to activate this.
 */
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV ?? 'development',
  tracesSampleRate: 1.0,
});

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });

  // SA-004: must run before anything reads req.ip — see trust-proxy.ts for
  // why this is a hop count and not `true`.
  configureTrustProxy(app);

  // Sprint 9: stricter helmet config than the bare default \u2014 a real CSP
  // for a JSON API (no inline scripts/styles ever served from here) plus
  // HSTS, since this always sits behind TLS in production.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'none'"], // this is a JSON API, not a page \u2014 nothing should load FROM it
          frameAncestors: ["'none'"],
        },
      },
      hsts: { maxAge: 15552000, includeSubDomains: true }, // 180 days
    }),
  );
  app.use(compression());

  app.enableCors({
    origin: process.env.CORS_ALLOWED_ORIGINS?.split(',') ?? [],
    credentials: true,
  });

  // B3 (PA-B-022): the four things that shape the JSON a real client receives —
  // the strict ValidationPipe (with B3's structured `VALIDATION_FAILED`
  // exception factory), the GlobalExceptionFilter, the LoggingInterceptor and
  // the `api/v1` prefix — now live in ONE function, shared with the e2e
  // suites. They used to be inlined here and re-approximated (loosely, and
  // WITHOUT the filter) inside each e2e spec, which is precisely how PA-B-021
  // shipped past 45 green assertions. See `common/http/global-pipeline.ts`.
  applyGlobalHttpPipeline(app);

  // Sprint 9: SIGTERM/SIGINT now trigger Nest's shutdown lifecycle
  // (OnModuleDestroy on PrismaService/RedisService, etc.) — without this,
  // a container orchestrator's graceful-shutdown grace period is wasted;
  // the process would be killed mid-request instead of draining cleanly.
  app.enableShutdownHooks();

  // F3 (R3): start the Outbox relay HERE and not in `OutboxRelay.onModuleInit`.
  // `AppModule` is instantiated by test/app.module.spec.ts and by the
  // cross-tenant probe; a relay that started itself on module init would open
  // database handles in suites that never asked for one and would keep Jest
  // alive. Starting it at the process entry point means exactly one thing
  // starts it — a real server — and tests drive `tick()` directly, which is
  // also what makes relay behaviour assertable rather than timing-dependent.
  //
  // `enableShutdownHooks()` above already calls its `onModuleDestroy`, which
  // clears the timer, so SIGTERM stops the poller before Prisma disconnects.
  app.get(OutboxRelay).start();

  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  await app.listen(port);
  logger.log(`AI Family Digital Coach API listening on port ${port}`);
}

bootstrap();
