import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { IJwtPayload } from '../../modules/auth/domain/auth.types';

/**
 * Usage: `@CurrentUser() user: IJwtPayload` in any controller behind
 * JwtAuthGuard or DeviceJwtAuthGuard. Passport attaches the strategy's
 * `validate()` return value to `request.user` — this decorator just gives
 * controllers a typed, explicit way to read it instead of reaching into
 * the raw request object.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): IJwtPayload => {
    const request = ctx.switchToHttp().getRequest();
    return request.user;
  },
);
