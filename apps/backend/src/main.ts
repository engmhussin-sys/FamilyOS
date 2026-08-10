import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import helmet from 'helmet';
import compression from 'compression';
import * as Sentry from '@sentry/node';

import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';

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
  const app = await NestFactory.create(AppModule);

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

  // Global validation: every DTO is validated against its class-validator
  // decorators before it ever reaches a controller method. `whitelist`
  // strips unknown properties instead of accepting them — the backend
  // never trusts client input beyond what a DTO explicitly declares.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // Sprint 9: every error response gets the same shape, and 5xx errors
  // never leak an internal message/stack to the client — see the
  // filter's own docstring.
  app.useGlobalFilters(new GlobalExceptionFilter());
  // Sprint 9: one structured JSON log line per request — see the
  // interceptor's own docstring for exactly what is and isn't logged.
  app.useGlobalInterceptors(new LoggingInterceptor());

  app.setGlobalPrefix('api/v1', {
    // Health checks are probed by infrastructure (Docker/Railway), which
    // does not know or care about this API's versioned prefix — excluded
    // so `/health/live` and `/health/ready` work at the bare path.
    exclude: ['health/live', 'health/ready'],
  });

  // Sprint 9: SIGTERM/SIGINT now trigger Nest's shutdown lifecycle
  // (OnModuleDestroy on PrismaService/RedisService, etc.) — without this,
  // a container orchestrator's graceful-shutdown grace period is wasted;
  // the process would be killed mid-request instead of draining cleanly.
  app.enableShutdownHooks();

  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  await app.listen(port);
  logger.log(`AI Family Digital Coach API listening on port ${port}`);
}

bootstrap();
