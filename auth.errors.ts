import { ConflictException, UnauthorizedException, NotFoundException } from '@nestjs/common';

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

export class InvalidOrExpiredPairingCodeException extends UnauthorizedException {
  constructor() {
    super('Pairing code is invalid or has expired. Please generate a new one.');
  }
}

export class ChildNotFoundException extends NotFoundException {
  constructor(childId: string) {
    super(`Child "${childId}" was not found in your family.`);
  }
}
