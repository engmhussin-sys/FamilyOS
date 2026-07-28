import { UnauthorizedException } from '@nestjs/common';

/** Identical message whether the code never existed, already expired, or
 * was already redeemed — never reveal which, same principle as every
 * other one-time-code error in this project (see auth-module.md's login
 * error, and the original PairingService.confirm). */
export class InvalidOrExpiredInvitationException extends UnauthorizedException {
  constructor() {
    super('Invitation code is invalid or has expired.');
  }
}
