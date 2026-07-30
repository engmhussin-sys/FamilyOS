import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { tap } from 'rxjs';
import type { Request } from 'express';

/**
 * Sprint 9's Structured Logging. Deliberately logs method/path/status/
 * latency/correlationId only \u2014 never request bodies (which routinely
 * contain passwords, tokens, or child data in this project) or response
 * bodies. Every log line is one JSON object per request, ready for any
 * log aggregator (CloudWatch, Railway's own log viewer, etc.) without
 * needing a parser tuned to this project's specific text format.
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler) {
    const request = context.switchToHttp().getRequest<Request>();
    const correlationId = (request as Request & { correlationId?: string }).correlationId ?? 'unknown';
    const startedAt = Date.now();

    return next.handle().pipe(
      tap({
        next: () => this.log(request, correlationId, startedAt, context),
        error: () => this.log(request, correlationId, startedAt, context),
      }),
    );
  }

  private log(request: Request, correlationId: string, startedAt: number, context: ExecutionContext): void {
    const response = context.switchToHttp().getResponse();
    const durationMs = Date.now() - startedAt;

    this.logger.log(
      JSON.stringify({
        correlationId,
        method: request.method,
        path: request.originalUrl ?? request.url,
        statusCode: response.statusCode,
        durationMs,
      }),
    );
  }
}
