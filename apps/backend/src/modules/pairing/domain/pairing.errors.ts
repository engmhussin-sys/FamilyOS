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

/** Thrown when neither deviceId nor childId is provided — the transition
 * has no entity to record the event against. */
export class MissingPairingCorrelationKeyException extends BadRequestException {
  constructor() {
    super('A pairing transition requires at least one of deviceId or childId.');
  }
}
