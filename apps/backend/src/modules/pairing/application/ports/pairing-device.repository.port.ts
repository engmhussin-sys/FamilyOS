export const PAIRING_DEVICE_REPOSITORY = Symbol('PAIRING_DEVICE_REPOSITORY');

export interface ICreatePairingDeviceInput {
  familyId: string;
  childId: string;
  publicKey: string;
  platform: 'ANDROID' | 'IOS';
  deviceModel?: string;
  osVersion?: string;
  appVersion?: string;
  pairingProtocolVersion?: string;
}

export interface IPairingDeviceRecord {
  id: string;
  childId: string;
  familyId: string;
  status: string;
  lastSeenAt: Date | null;
  capabilityProfile: Record<string, unknown> | null;
  capabilityProfileHash: string | null;
  /** Sprint 5 — exposed so listFamilyDevices can surface runtime
   * enforcement status without a second query. */
  lastTelemetry: Record<string, unknown> | null;
}

export interface IPairingDeviceWithChild extends IPairingDeviceRecord {
  childFirstName: string;
  platform: string;
}

/**
 * Scoped narrowly to what the Pairing flow itself needs to do to a
 * `Device` row — NOT a general-purpose device CRUD repository (that
 * doesn't exist as a concept anywhere in this project; devices are
 * managed exclusively through the pairing lifecycle). This is now the
 * ONLY device repository in the codebase: Auth's own
 * `PrismaDeviceRepository` and the deprecated one-step pairing endpoints
 * it backed were deleted (SA-003), so there is no longer a second path
 * that can create a child device — and this one always creates it as
 * PENDING_PAIRING with the Sprint-2/2.2.1 fields
 * (publicKey/pairingProtocolVersion/trustLevel-default) set.
 */
export interface IPairingDeviceRepository {
  createDevice(input: ICreatePairingDeviceInput): Promise<IPairingDeviceRecord>;
  findById(deviceId: string): Promise<IPairingDeviceRecord | null>;
  activateDevice(deviceId: string): Promise<void>;
  revokeDevice(deviceId: string): Promise<void>;
  /** Heartbeat support — a lightweight write, deliberately NOT routed
   * through the DevicePairingEvent ledger on every call (lifecycle ADR
   * §10 / risk-score-framework.md §8's sampling principle, generalized:
   * routine "still alive" pings update a field, not an audit row every
   * time; only actual state transitions — DEGRADED -> HEALTHY — get an
   * event, via PairingStateMachineService). */
  touchLastSeen(deviceId: string): Promise<void>;
  /** Sprint 4 — stores the Full Capability Engine's report, cached
   * (Decision-019), replacing whatever was there before — this is
   * current state, not history. */
  updateCapabilityProfile(
    deviceId: string,
    profile: Record<string, unknown>,
    profileHash: string,
  ): Promise<void>;
  /** Sprint 4 — the Dashboard's device-list query. Family-scoped by the
   * caller (ownership already established via JwtAuthGuard's familyId). */
  findAllByFamily(familyId: string): Promise<IPairingDeviceWithChild[]>;
  /** Sprint 4 — cached heartbeat telemetry (current state, not history). */
  updateTelemetry(deviceId: string, telemetry: Record<string, unknown>): Promise<void>;
  /** Sprint 5 (Push Notifications) — CLOSES A REAL GAP: no path
   * anywhere ever registered a PARENT-owned device (the Parent App
   * instance itself, distinct from a CHILD device this repository's
   * other methods already handle). Upserts by (userId, platform) —
   * a parent may reasonably have more than one device (phone +
   * tablet), each gets its own row; re-registering the same
   * platform just refreshes its token rather than creating a
   * duplicate. */
  upsertParentDevicePushToken(input: {
    userId: string;
    familyId: string;
    platform: 'ANDROID' | 'IOS';
    pushToken: string;
  }): Promise<void>;
  /** Sprint 5 — the read side push-sending needs: every push token
   * registered for a given user, across however many devices. */
  findPushTokensForUser(userId: string): Promise<string[]>;
}
