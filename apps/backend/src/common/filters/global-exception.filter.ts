import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import * as Sentry from '@sentry/node';

import { shapeErrorResponse } from '../errors/error-response';

/**
 * Sprint 9's Security Hardening + API Hardening, and B3's Global Error
 * Contract, in one filter:
 *
 *   - Every error response has the SAME shape, regardless of what threw it —
 *     `{ statusCode, code, message, messageAr, details, requestId,
 *     correlationId, timestamp, path }`. See `../errors/error-response.ts` for
 *     the contract itself and for why `requestId` is an ALIAS of the existing
 *     correlation id rather than a second identifier.
 *
 *   - B3 / PA-B-021 — THE DEFECT THIS FILE USED TO BE. `extractMessage` tested
 *     `'message' in body` and, finding none on a `{ code, messageAr }` body,
 *     fell back to `exception.message` — which Nest derives from the class
 *     name. Production therefore answered a child who had reached her daily
 *     limit with `{"message":"Conflict Exception"}` instead of «أكملت هذا
 *     البرنامج مرة اليوم — وهذا هو الحد اليومي. نراك غدًا!». Every Arabic
 *     non-punitive sentence in the reward engine was unreachable by any client.
 *     Shaping now lives in one pure function that CANNOT return a body without
 *     `code` and `messageAr`, and `test/common/error-contract.e2e.spec.ts`
 *     asserts that over a real HTTP socket, through the real `api/v1` prefix,
 *     with this filter installed — which is what the old e2e suites never did
 *     (PA-B-022).
 *
 *   - An unrecognized (non-HttpException) error NEVER leaks its message or
 *     stack to the client — only the generic 500 text, with a `requestId` the
 *     client can report back. The real message/stack goes to the server log
 *     only, at `error` level, and to Sentry.
 *
 *   - Every known HttpException keeps its real English message in `message` —
 *     those are intentional, safe-to-expose messages already reviewed by this
 *     project's own error-class design. Backward compatibility for the admin
 *     dashboard (`httpClient.ts`) and both Flutter clients (`api_client.dart`)
 *     is therefore total: `message`, `statusCode`, `correlationId`, `timestamp`
 *     and `path` all still mean exactly what they meant.
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const correlationId = (request as Request & { correlationId?: string }).correlationId ?? 'unknown';

    const isHttpException = exception instanceof HttpException;
    const status = isHttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    const payload = shapeErrorResponse({
      status,
      isHttpException,
      body: isHttpException ? exception.getResponse() : undefined,
      fallbackMessage: isHttpException ? exception.message : undefined,
      correlationId,
      path: request.url,
      timestamp: new Date().toISOString(),
    });

    if (!isHttpException || status >= 500) {
      // The FULL detail — real message, real stack — lives here and ONLY here.
      // `LoggingInterceptor`'s PII rule is unchanged: no request or response
      // body is ever logged, so a child's data cannot reach a log line through
      // this path either.
      this.logger.error(
        `[${correlationId}] ${request.method} ${request.url} -> ${status} (${payload.code}): ${
          exception instanceof Error ? exception.message : String(exception)
        }`,
        exception instanceof Error ? exception.stack : undefined,
      );
      // Sprint 4 (Observability): same condition as the local log line above,
      // deliberately — one rule for "this is a real error worth attention,"
      // not two that could silently diverge.
      Sentry.captureException(exception, { tags: { correlationId } });
    }

    response.status(status).json(payload);
  }
}
