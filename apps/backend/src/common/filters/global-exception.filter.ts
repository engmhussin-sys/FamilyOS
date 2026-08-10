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

/**
 * Sprint 9's Security Hardening + API Hardening, combined in one filter:
 *   - Every error response has the SAME shape, regardless of what threw
 *     it \u2014 a client integration never has to special-case an
 *     unexpected error format.
 *   - An unrecognized (non-HttpException) error NEVER leaks its message
 *     or stack to the client \u2014 only a generic "internal error"
 *     message, with a correlation ID the client can report back. The
 *     real message/stack goes to the server log only, at `error` level.
 *   - Every known HttpException (NotFoundException, ConflictException,
 *     the project's own PaymentProviderNotConfiguredException, etc.)
 *     keeps its real message \u2014 those are intentional, safe-to-expose
 *     error messages already reviewed by this project's own error-class
 *     design (they never contain secrets or internals by construction).
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

    const clientMessage = isHttpException
      ? this.extractMessage(exception)
      : 'An internal error occurred. Please try again or contact support with this reference.';

    if (!isHttpException || status >= 500) {
      this.logger.error(
        `[${correlationId}] ${request.method} ${request.url} -> ${status}: ${
          exception instanceof Error ? exception.message : String(exception)
        }`,
        exception instanceof Error ? exception.stack : undefined,
      );
      // Sprint 4 (Observability): same condition as the local log
      // line above, deliberately — one rule for "this is a real
      // error worth attention," not two that could silently diverge.
      Sentry.captureException(exception, { tags: { correlationId } });
    }

    response.status(status).json({
      statusCode: status,
      message: clientMessage,
      correlationId,
      timestamp: new Date().toISOString(),
      path: request.url,
    });
  }

  private extractMessage(exception: HttpException): string | string[] {
    const body = exception.getResponse();
    if (typeof body === 'string') return body;
    if (typeof body === 'object' && body !== null && 'message' in body) {
      return (body as { message: string | string[] }).message;
    }
    return exception.message;
  }
}
