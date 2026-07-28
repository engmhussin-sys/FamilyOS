import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { IConsumedRegistrationToken } from '../../domain/registration-token.types';

export const RegistrationContext = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): IConsumedRegistrationToken => {
    const request = ctx.switchToHttp().getRequest();
    return request.registrationContext;
  },
);
