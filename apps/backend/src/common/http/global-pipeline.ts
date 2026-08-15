import { BadRequestException, INestApplication, ValidationPipe } from '@nestjs/common';
import type { ValidationError } from '@nestjs/common';

import { GlobalExceptionFilter } from '../filters/global-exception.filter';
import { LoggingInterceptor } from '../interceptors/logging.interceptor';
import { CODE_CATALOGUE } from '../errors/error-catalogue';

/**
 * B3 / PA-B-022 — THE TESTING GAP, CLOSED STRUCTURALLY.
 *
 * The Arabic-error defect (PA-B-021) survived 45 e2e assertions because those
 * suites hand-rolled their own bootstrap: `reward-engine.e2e.spec.ts:274-276`
 * and `event-pipeline.e2e.spec.ts:350-353` installed a LOOSER `ValidationPipe`
 * (no `forbidNonWhitelisted`), no `GlobalExceptionFilter` at all, and no
 * `api/v1` prefix — so they asserted a response shape and a URL space that no
 * deployed client has ever seen. Nest's DEFAULT filter was answering them.
 *
 * Re-adding the three calls to those suites would have fixed the symptom and
 * left the cause: two independent bootstraps, free to drift again the moment
 * `main.ts` changes. So the bootstrap is now ONE function, called by `main.ts`
 * and by the e2e suites. A future change to the deployed HTTP contract cannot
 * be made without the tests seeing it.
 *
 * Deliberately NOT included here: `helmet`, `compression`, CORS, trust-proxy
 * and shutdown hooks. Those are transport/deployment concerns that do not shape
 * the JSON contract, they need a `NestExpressApplication` rather than the
 * `INestApplication` a test gets, and pulling them in would make every e2e
 * suite pay for middleware it does not assert.
 */
export const API_GLOBAL_PREFIX = 'api/v1';

/**
 * Health checks are probed by infrastructure (Docker/Railway), which does not
 * know or care about this API's versioned prefix.
 */
export const API_PREFIX_EXCLUDED = ['health/live', 'health/ready'];

export function buildValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    // `whitelist` strips unknown properties instead of accepting them — the
    // backend never trusts client input beyond what a DTO explicitly declares.
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: true },
    // B3: a DTO failure is now a first-class member of the error contract
    // instead of an untyped `string[]`. `message` keeps the exact `string[]`
    // Nest has always produced (the admin dashboard joins it —
    // `httpClient.ts:44`), and `details.fields` adds the per-field breakdown a
    // form needs in order to highlight the offending input.
    exceptionFactory: (errors: ValidationError[]) =>
      new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: flattenConstraints(errors),
        messageAr: CODE_CATALOGUE.VALIDATION_FAILED.messageAr,
        details: { fields: flattenFields(errors) },
      }),
  });
}

/** Applies everything that shapes the JSON a real client receives. */
export function applyGlobalHttpPipeline(app: INestApplication): void {
  app.useGlobalPipes(buildValidationPipe());
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.useGlobalInterceptors(new LoggingInterceptor());
  app.setGlobalPrefix(API_GLOBAL_PREFIX, { exclude: API_PREFIX_EXCLUDED });
}

interface FieldError {
  readonly field: string;
  readonly constraints: string[];
}

function flattenFields(errors: ValidationError[], parent = ''): FieldError[] {
  const out: FieldError[] = [];
  for (const error of errors) {
    const field = parent ? `${parent}.${error.property}` : error.property;
    const constraints = error.constraints ? Object.keys(error.constraints) : [];
    if (constraints.length > 0) out.push({ field, constraints });
    if (error.children && error.children.length > 0) {
      out.push(...flattenFields(error.children, field));
    }
  }
  return out;
}

/** Byte-for-byte the sentences Nest's own default factory produces. */
function flattenConstraints(errors: ValidationError[]): string[] {
  const out: string[] = [];
  for (const error of errors) {
    if (error.constraints) out.push(...Object.values(error.constraints));
    if (error.children && error.children.length > 0) out.push(...flattenConstraints(error.children));
  }
  return out;
}
