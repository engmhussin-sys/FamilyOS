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
}

/**
 * Scoped narrowly to what the Pairing flow itself needs to do to a
 * `Device` row — NOT a general-purpose device CRUD repository (that
 * doesn't exist as a concept anywhere in this project; devices are
 * managed exclusively through the pairing lifecycle). Distinct from
 * Auth's own `PrismaDeviceRepository` (used only by the now-Deprecated
 * `/auth/devices/pairing/*` endpoints, per pairing-module-boundary.md §5)
 * since this one sets the Sprint-2/2.2.1 fields
 * (publicKey/pairingProtocolVersion/trustLevel-default) that endpoint
 * never needed to know about.
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
}
