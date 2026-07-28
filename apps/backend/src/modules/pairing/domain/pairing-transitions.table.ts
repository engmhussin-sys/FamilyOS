import type { IPairingTransitionRule } from './pairing.types';

/**
 * The single source of truth for legal pairing transitions. Every row
 * here corresponds to a documented decision:
 *   - Happy path: pairing-state-machine.md §4 / pairing-backend-domain-architecture.md §2
 *   - Reject (broadened scope): Decision-056
 *   - Reactivation/Revocation: pairing-state-machine.md §4's transition table
 *   - Expiry: Decision-059's PAIRING_EXPIRED, newly given a terminal
 *     PairingState (REJECTED/EXPIRED) in this step — see schema.prisma's
 *     comment on those two enum values for why they didn't exist before.
 *
 * `null` in `allowedFromStates` means "valid as the first event recorded
 * for a given childId" (no prior Device/pairing history at all).
 */
export const PAIRING_TRANSITIONS: readonly IPairingTransitionRule[] = [
  // --- Happy path ---
  { event: 'PAIRING_INVITED', allowedFromStates: [null], toState: 'INVITATION_SENT', actorType: 'USER' },
  { event: 'PAIRING_ACCEPTED', allowedFromStates: ['INVITATION_SENT'], toState: 'AUTHENTICATING', actorType: 'DEVICE' },
  { event: 'DEVICE_REGISTERED', allowedFromStates: ['AUTHENTICATING'], toState: 'DEVICE_REGISTERED', actorType: 'DEVICE' },
  { event: 'DEVICE_VERIFIED', allowedFromStates: ['DEVICE_REGISTERED'], toState: 'DEVICE_VERIFIED', actorType: 'DEVICE' },
  { event: 'CAPABILITIES_UPLOADED', allowedFromStates: ['DEVICE_VERIFIED'], toState: 'CAPABILITIES_UPLOADED', actorType: 'DEVICE' },
  { event: 'PARENT_CONFIRMED', allowedFromStates: ['CAPABILITIES_UPLOADED'], toState: 'PARENT_CONFIRMED', actorType: 'USER' },
  { event: 'POLICY_ASSIGNED', allowedFromStates: ['PARENT_CONFIRMED'], toState: 'POLICY_ASSIGNED', actorType: 'SYSTEM' },
  { event: 'DEVICE_ACTIVATED', allowedFromStates: ['POLICY_ASSIGNED'], toState: 'ACTIVATED', actorType: 'SYSTEM' },

  // --- Ongoing operational states (Step 10, Observability — heartbeat-driven) ---
  { event: 'HEARTBEAT_RECEIVED', allowedFromStates: ['ACTIVATED', 'DEGRADED'], toState: 'HEALTHY', actorType: 'DEVICE' },
  { event: 'HEARTBEAT_MISSED', allowedFromStates: ['HEALTHY'], toState: 'DEGRADED', actorType: 'SYSTEM' },

  // --- Suspension / reactivation / revocation / removal ---
  { event: 'DEVICE_SUSPENDED', allowedFromStates: ['HEALTHY', 'DEGRADED'], toState: 'SUSPENDED', actorType: 'USER' },
  { event: 'DEVICE_REACTIVATED', allowedFromStates: ['SUSPENDED'], toState: 'ACTIVATED', actorType: 'USER' },
  { event: 'DEVICE_REVOKED', allowedFromStates: ['HEALTHY', 'DEGRADED', 'SUSPENDED'], toState: 'REVOKED', actorType: 'USER' },
  { event: 'DEVICE_REMOVED', allowedFromStates: ['REVOKED'], toState: 'REMOVED', actorType: 'USER' },

  // --- Rejection (Decision-056: broadened to any post-accept, pre-activation state) ---
  {
    event: 'PAIRING_REJECTED',
    allowedFromStates: ['AUTHENTICATING', 'DEVICE_REGISTERED', 'DEVICE_VERIFIED', 'CAPABILITIES_UPLOADED'],
    toState: 'REJECTED',
    actorType: 'USER',
  },

  // --- Terminal failures ---
  { event: 'AUTHENTICATION_FAILED', allowedFromStates: ['AUTHENTICATING'], toState: 'REJECTED', actorType: 'SYSTEM' },
  { event: 'DEVICE_VERIFICATION_FAILED', allowedFromStates: ['DEVICE_REGISTERED'], toState: 'REJECTED', actorType: 'SYSTEM' },

  // --- Expiry ---
  { event: 'PAIRING_EXPIRED', allowedFromStates: ['INVITATION_SENT'], toState: 'EXPIRED', actorType: 'SYSTEM' },

  // --- Risk-gated activation block (Decision-032/§4 of risk-score-framework.md) ---
  // Does NOT transition state — activation simply doesn't happen. Modeled
  // as a distinct event so it's still audited (Decision-059: "no
  // transition without audit" — this is an audited NON-transition,
  // recorded with fromState === toState).
  { event: 'ACTIVATION_BLOCKED_HIGH_RISK', allowedFromStates: ['CAPABILITIES_UPLOADED'], toState: 'CAPABILITIES_UPLOADED', actorType: 'SYSTEM' },
] as const;
