import { ConflictException, UnauthorizedException } from '@nestjs/common';

/**
 * Domain errors for Auth. They extend Nest's HTTP exceptions directly so
 * they can be thrown from application services and still produce correct
 * HTTP responses without the controller needing a translation layer —
 * a pragmatic trade-off for this module (pure domain exceptions + a mapper
 * would be more "textbook" clean architecture, but would add a layer of
 * indirection with no real benefit for a module this size).
 */

export class EmailAlreadyRegisteredException extends ConflictException {
  constructor(email: string) {
    super(`An account with email "${email}" already exists.`);
  }
}

export class InvalidCredentialsException extends UnauthorizedException {
  constructor() {
    super('Invalid email or password.');
  }
}

export class AccountNotActiveException extends UnauthorizedException {
  constructor() {
    super('This account is not active. Please verify your email or contact support.');
  }
}

export class InvalidOrExpiredTokenException extends UnauthorizedException {
  constructor(message = 'Token is invalid, expired, or has been revoked.') {
    super(message);
  }
}

/**
 * SA-002. Thrown when a refresh token that was already rotated out is
 * presented again — the classic signature of a stolen refresh token
 * (the legitimate client and the attacker are both holding a copy of the
 * same chain). Extends InvalidOrExpiredTokenException so the HTTP
 * response is byte-identical to the generic failure: the caller must not
 * be able to tell "forged" from "already used", or an attacker could
 * probe for valid-but-consumed tokens. The difference is entirely
 * server-side: the whole token family is revoked and a security event is
 * written to the audit log.
 */
export class RefreshTokenReuseDetectedException extends InvalidOrExpiredTokenException {
  constructor() {
    super();
  }
}

export class InvalidOrExpiredPairingCodeException extends UnauthorizedException {
  constructor() {
    super('Pairing code is invalid or has expired. Please generate a new one.');
  }
}
