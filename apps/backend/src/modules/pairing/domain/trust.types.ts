import type { PairingStateValue } from './pairing.types';

/** Mirrors schema.prisma's TrustLevel enum — kept as a plain TS union,
 * not imported from @prisma/client, consistent with this project's
 * established domain-layer/ORM separation (see auth.service.ts's
 * `toFamilyRole` docstring for the identical reasoning). */
export const TRUST_LEVELS = [
  'L0_UNKNOWN',
  'L1_REGISTERED',
  'L2_VERIFIED',
  'L3_ATTESTED',
  'L4_ENTERPRISE',
  'L5_HIGH_TRUST',
] as const;
export type TrustLevelValue = (typeof TRUST_LEVELS)[number];

/** Which pairing-lifecycle moment triggered this evaluation — the exact
 * derivation rules this drives are in trust-levels-framework.md §2. */
export type TrustEvaluationStage = 'REGISTERED' | 'VERIFIED';

export interface ITrustEvaluationInput {
  deviceId: string;
  childId: string;
  stage: TrustEvaluationStage;
  /** Only meaningful at stage 'VERIFIED' — was a Key Attestation chain
   * present and cryptographically valid. */
  hasValidAttestation?: boolean;
  /** Independent of attestation — Device Owner provisioning (Android
   * enforcement ADR §4's "Enhanced Mode"). */
  isDeviceOwnerProvisioned?: boolean;
}

export interface ITrustChangeRecord {
  deviceId: string;
  childId: string;
  fromLevel: TrustLevelValue | null;
  toLevel: TrustLevelValue;
  reason: string;
  pairingStateAtChange: PairingStateValue | null;
  occurredAt: Date;
}

/**
 * Decision-068/Sprint-2's "Trust Signal Provider Interface" — the stable
 * contract a future AI Core Engine consumer depends on, instead of
 * importing TrustEvaluationService (or any Pairing-module concrete
 * class) directly. Exposes exactly what Sprint 2's brief asked AI to
 * eventually be able to use: why trust dropped (reason, on every
 * record), device pattern (current level), and history (full timeline).
 */
export interface ITrustSignalProvider {
  getCurrentTrustLevel(deviceId: string): Promise<TrustLevelValue | null>;
  getTrustHistory(childId: string): Promise<ITrustChangeRecord[]>;
}
