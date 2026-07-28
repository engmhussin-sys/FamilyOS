import type { PairingActorType, PairingEventTypeValue, PairingStateValue } from '../../domain/pairing.types';

export const PAIRING_EVENT_REPOSITORY = Symbol('PAIRING_EVENT_REPOSITORY');

export interface IRecordPairingEventInput {
  childId: string;
  deviceId?: string;
  eventType: PairingEventTypeValue;
  fromState: PairingStateValue | null;
  toState: PairingStateValue;
  actorType: PairingActorType;
  actorId?: string;
  metadata?: Record<string, unknown>;
}

export interface IPairingEventRecord {
  id: string;
  childId: string;
  deviceId: string | null;
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
   * The child's most recent pairing event — this IS the derived
   * "PairingSession" read (pairing-backend-domain-architecture.md §1.5).
   * Always keyed on childId (Decision-066's Audit Query Design rule),
   * never deviceId — this is what keeps a child's pairing timeline
   * coherent across a future device replacement, per that decision.
   */
  findLatest(childId: string): Promise<IPairingEventRecord | null>;
}
