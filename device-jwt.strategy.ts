import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

import type { IJwtPayload } from '../../domain/auth.types';

/**
 * Separate Passport strategy (name: 'device-jwt') for tokens issued to a
 * paired Child App device. Kept distinct from JwtStrategy so a stolen
 * device token can never be used against parent-only endpoints and
 * vice versa — the two token families are not interchangeable even though
 * they share the same JWT signing mechanism.
 */
@Injectable()
export class DeviceJwtStrategy extends PassportStrategy(Strategy, 'device-jwt') {
  constructor(configService: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.getOrThrow<string>('JWT_ACCESS_SECRET'),
    });
  }

  validate(payload: IJwtPayload): IJwtPayload {
    if (payload.tokenKind !== 'access' || payload.actorType !== 'DEVICE') {
      throw new UnauthorizedException('This endpoint requires a device access token.');
    }
    return payload;
  }
}
