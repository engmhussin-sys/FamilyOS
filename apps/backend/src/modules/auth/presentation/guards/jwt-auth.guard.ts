import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/** Protects routes that require a valid parent (USER) access token. */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}

/** Protects routes that require a valid paired child-device access token. */
@Injectable()
export class DeviceJwtAuthGuard extends AuthGuard('device-jwt') {}
