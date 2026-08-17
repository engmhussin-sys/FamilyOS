import type { IPairingTransitionRule, PairingEventTypeValue } from './pairing.types';

/**
 * Decision-065/066's Event Matrix, made explicit and enforceable: these
 * events cannot fire without a deviceId, because they describe something
 * that happens TO a specific device. Every other event (PAIRING_INVITED,
 * PAIRING_ACCEPTED, PARENT_CONFIRMED, PAIRING_REJECTED, PAIRING_EXPIRED,
 * AUTHENTICATION_FAILED) is childId-only by design — a device may or may
 * not exist yet when they fire, so none of them are enforced here.
 */
export const DEVICE_REQUIRED_EVENTS: ReadonlySet<PairingEventTypeValue> = new Set([
  'DEVICE_REGISTERED',
  'DEVICE_VERIFIED',
  'DEVICE_VERIFICATION_FAILED',
  'CAPABILITIES_UPLOADED',
  'POLICY_ASSIGNED',
  'DEVICE_ACTIVATED',
  'ACTIVATION_BLOCKED_HIGH_RISK',
  'HEARTBEAT_RECEIVED',
  'HEARTBEAT_MISSED',
  'DEVICE_SUSPENDED',
  'DEVICE_REACTIVATED',
  'DEVICE_REVOKED',
  'DEVICE_REMOVED',
]);

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
  // ACTIVATED IS A LEGAL «FROM» FOR REVOCATION, and its absence was a real
  // hole rather than a deliberate omission.
  //
  // A device enters ACTIVATED the instant the parent confirms it and leaves it
  // only on its FIRST HEARTBEAT (HEARTBEAT_RECEIVED -> HEALTHY). That window is
  // measured in seconds when the child's phone is switched on, and in HOURS OR
  // DAYS when it is not: a code typed into the wrong phone, a device left in a
  // drawer, a pairing abandoned halfway. It is also exactly the window in which
  // a parent who has just realised they mis-paired wants to undo it.
  //
  // Before this line, `POST /pairing/revoke` answered that parent with 409
  // `InvalidPairingTransitionException` — the one moment revocation is most
  // obviously correct was the one moment it was refused, and the only way out
  // was to wait for the mis-paired device to phone home first. REVOKED is
  // already reachable from every LATER state; this makes it reachable from the
  // earliest one at which a device holds a usable token.
  { event: 'DEVICE_REVOKED', allowedFromStates: ['ACTIVATED', 'HEALTHY', 'DEGRADED', 'SUSPENDED'], toState: 'REVOKED', actorType: 'USER' },
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

  // --- Trust-level changes (Sprint 2, Service 4) ---
  // Same "audited non-transition" shape as ACTIVATION_BLOCKED_HIGH_RISK
  // above, generalized across every state where TrustEvaluationService
  // might run: registration, verification, and every post-activation
  // operational state (an attestation re-check or Device Owner
  // provisioning can happen well after initial pairing). Generated from
  // an array instead of hand-typed per-state to avoid literal repetition
  // while keeping the underlying rule list flat, explicit data — same
  // philosophy as every other rule in this table, not a new mechanism.
  ...([
    'DEVICE_REGISTERED',
    'DEVICE_VERIFIED',
    'CAPABILITIES_UPLOADED',
    'PARENT_CONFIRMED',
    'POLICY_ASSIGNED',
    'ACTIVATED',
    'HEALTHY',
    'DEGRADED',
    'SUSPENDED',
  ] as const).map(
    (state): IPairingTransitionRule => ({
      event: 'DEVICE_TRUST_CHANGED',
      allowedFromStates: [state],
      toState: state,
      actorType: 'SYSTEM',
    }),
  ),
] as const;
