import { ConflictException, BadRequestException } from '@nestjs/common';

/**
 * Thrown when a requested event is not valid from the entity's current
 * state — e.g. trying to fire DEVICE_ACTIVATED before PARENT_CONFIRMED
 * has happened. This is the state machine's core enforcement mechanism:
 * an invalid transition is refused, not silently corrected or ignored.
 */
export class InvalidPairingTransitionException extends ConflictException {
  constructor(event: string, currentState: string | null) {
    super(
      `Event "${event}" is not valid from current state "${currentState ?? '(none)'}".`,
    );
  }
}

/** Thrown when childId is missing — the Primary Owner reference
 * (Decision-066) every pairing event requires, regardless of whether a
 * device has been registered yet. TypeScript's type system already
 * requires this at compile time; this is the runtime backstop for
 * callers that bypass typing (e.g. a future controller's raw request body). */
export class MissingChildIdException extends BadRequestException {
  constructor() {
    super('A pairing transition requires childId — the Primary Owner reference.');
  }
}

/** Thrown when an event that requires a device reference (e.g.
 * DEVICE_REGISTERED, DEVICE_ACTIVATED, DEVICE_REVOKED — see
 * DEVICE_REQUIRED_EVENTS) is fired without deviceId. Pre-device-registration
 * events (PAIRING_INVITED, PAIRING_ACCEPTED, PARENT_CONFIRMED, ...) do NOT
 * require this and must not trigger it. */
export class MissingDeviceIdException extends BadRequestException {
  constructor(event: string) {
    super(`Event "${event}" requires deviceId, but none was provided.`);
  }
}
