import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';

import { RegistrationTokenService } from '../../application/services/registration-token.service';

/**
 * Validates a registration token (Decision-054's third token type) and
 * attaches the resulting `{ childId, familyId }` to the request as
 * `registrationContext` — read via the `@RegistrationContext()` decorator.
 * Deliberately NOT JwtAuthGuard or DeviceJwtAuthGuard — a
 * partially-registered device (redeemed an invitation, hasn't created a
 * keypair-backed Device row yet) must not be able to call any other
 * protected endpoint (pairing-backend-domain-architecture.md §4.2).
 */
@Injectable()
export class RegistrationTokenGuard implements CanActivate {
  constructor(private readonly registrationTokenService: RegistrationTokenService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const authHeader = request.headers.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing registration token.');
    }

    const token = authHeader.slice('Bearer '.length);
    const consumed = await this.registrationTokenService.consume(token);

    (request as Request & { registrationContext?: unknown }).registrationContext = consumed;
    return true;
  }
}
