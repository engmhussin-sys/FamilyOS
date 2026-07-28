import { UnauthorizedException } from '@nestjs/common';

export class InvalidOrConsumedRegistrationTokenException extends UnauthorizedException {
  constructor() {
    super('Registration token is invalid, expired, or has already been used.');
  }
}
