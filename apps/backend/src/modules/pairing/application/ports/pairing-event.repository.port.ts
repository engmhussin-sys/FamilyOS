import type { PairingActorType, PairingEventTypeValue, PairingStateValue } from '../../domain/pairing.types';

export const PAIRING_EVENT_REPOSITORY = Symbol('PAIRING_EVENT_REPOSITORY');

export interface IRecordPairingEventInput {
  deviceId?: string;
  childId?: string;
  eventType: PairingEventTypeValue;
  fromState: PairingStateValue | null;
  toState: PairingStateValue;
  actorType: PairingActorType;
  actorId?: string;
  metadata?: Record<string, unknown>;
}

export interface IPairingEventRecord {
  id: string;
  deviceId: string | null;
  childId: string | null;
  eventType: string;
  fromState: string | null;
  toState: string;
  actorType: string;
  actorId: string | null;
  occurredAt: Date;
}

export interface IPairingEventRepository {
  /** Append-only write — never an update. */
  record(input: IRecordPairingEventInput): Promise<IPairingEventRecord>;

  /**
   * The device's/child's most recent event — this IS the derived
   * "PairingSession" read specified in
   * pairing-backend-domain-architecture.md §1.5. Looks up by deviceId
   * once one exists, falling back to childId for pre-registration
   * lookups (before a Device row is assigned).
   */
  findLatest(correlation: { deviceId?: string; childId?: string }): Promise<IPairingEventRecord | null>;
}
