/**
 * Mirrors the PairingState/PairingEventType/ActorType Prisma enums as
 * plain TS types — the domain layer doesn't import from '@prisma/client'
 * directly for control-flow types, consistent with every other module's
 * layering (see auth.service.ts's `toFamilyRole` docstring for the same
 * reasoning applied elsewhere).
 */

export const PAIRING_STATES = [
  'INVITATION_CREATED',
  'INVITATION_SENT',
  'INVITATION_OPENED',
  'AUTHENTICATING',
  'DEVICE_REGISTERED',
  'DEVICE_VERIFIED',
  'CAPABILITIES_UPLOADED',
  'PARENT_CONFIRMED',
  'POLICY_ASSIGNED',
  'ACTIVATED',
  'HEALTHY',
  'DEGRADED',
  'SUSPENDED',
  'REVOKED',
  'REMOVED',
  'REJECTED',
  'EXPIRED',
] as const;
export type PairingStateValue = (typeof PAIRING_STATES)[number];

export const PAIRING_EVENT_TYPES = [
  'PAIRING_INVITED',
  'PAIRING_ACCEPTED',
  'PAIRING_REJECTED',
  'PAIRING_EXPIRED',
  'AUTHENTICATION_STARTED',
  'AUTHENTICATION_SUCCEEDED',
  'AUTHENTICATION_FAILED',
  'DEVICE_REGISTERED',
  'DEVICE_VERIFIED',
  'DEVICE_VERIFICATION_FAILED',
  'CAPABILITIES_UPLOADED',
  'PARENT_CONFIRMED',
  'POLICY_ASSIGNED',
  'DEVICE_ACTIVATED',
  'ACTIVATION_BLOCKED_HIGH_RISK',
  'HEARTBEAT_RECEIVED',
  'HEARTBEAT_MISSED',
  'DEVICE_SUSPENDED',
  'DEVICE_REACTIVATED',
  'DEVICE_REVOKED',
  'DEVICE_REMOVED',
] as const;
export type PairingEventTypeValue = (typeof PAIRING_EVENT_TYPES)[number];

export type PairingActorType = 'USER' | 'DEVICE' | 'SYSTEM';

/**
 * One row of the transition table — the single source of truth for
 * "which (event, currentState) combinations are legal," per this step's
 * "Valid transitions / state validation" requirement.
 */
export interface IPairingTransitionRule {
  event: PairingEventTypeValue;
  /** States this event is valid FROM. `null` in this list means "valid
   * as the very first event for a not-yet-existing device/childId." */
  allowedFromStates: ReadonlyArray<PairingStateValue | null>;
  toState: PairingStateValue;
  actorType: PairingActorType;
}

/** Input to `PairingStateMachineService.transition` — deliberately
 * requires EITHER deviceId or childId (or both), never neither, matching
 * the nullable-deviceId schema fix from this step (a pre-registration
 * event has no deviceId yet, but always has a childId). */
export interface IPairingTransitionInput {
  deviceId?: string;
  childId?: string;
  event: PairingEventTypeValue;
  actorType: PairingActorType;
  actorId?: string;
  metadata?: Record<string, unknown>;
}
