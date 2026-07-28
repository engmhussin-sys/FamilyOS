import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

import type { IJwtPayload } from '../../domain/auth.types';

/**
 * Validates the access token signature/expiry/kind via Passport's
 * strategy contract. This intentionally does NOT hit the database (unlike
 * refresh-token verification) — access tokens are short-lived (15 min) by
 * design specifically so they can be checked statelessly on every request
 * without a DB round-trip, trading a 15-minute revocation delay for much
 * lower latency on the hot path.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(configService: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.getOrThrow<string>('JWT_ACCESS_SECRET'),
    });
  }

  validate(payload: IJwtPayload): IJwtPayload {
    if (payload.tokenKind !== 'access' || payload.actorType !== 'USER') {
      throw new UnauthorizedException('This endpoint requires a parent access token.');
    }
    return payload;
  }
}
