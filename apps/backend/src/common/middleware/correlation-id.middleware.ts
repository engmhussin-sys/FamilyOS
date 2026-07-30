import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { NextFunction, Request, Response } from 'express';

/**
 * Sprint 9's Observability. Accepts an inbound `X-Correlation-Id` (so a
 * request already traced upstream, e.g. by a load balancer, keeps its
 * ID) or generates a new one. Attached to `req` for
 * `GlobalExceptionFilter`/`LoggingInterceptor` to read, and echoed back
 * in the response header so a client (or the Dashboard) can log it
 * alongside its own error report.
 */
@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.headers['x-correlation-id'];
    const correlationId = typeof incoming === 'string' && incoming.length > 0 ? incoming : randomUUID();

    (req as Request & { correlationId?: string }).correlationId = correlationId;
    res.setHeader('X-Correlation-Id', correlationId);
    next();
  }
}
