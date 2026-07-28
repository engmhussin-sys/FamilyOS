import type { TrustLevelValue } from '../../domain/trust.types';

/** Bind a future ai-core consumer to THIS token, not to
 * TrustEvaluationService directly — dependency inversion across the
 * module boundary, same instinct as every repository port in this
 * project, applied to a cross-module signal contract instead of a
 * data-access one. */
export const TRUST_SIGNAL_PROVIDER = Symbol('TRUST_SIGNAL_PROVIDER');

export const DEVICE_TRUST_REPOSITORY = Symbol('DEVICE_TRUST_REPOSITORY');

export interface IDeviceTrustRepository {
  getTrustLevel(deviceId: string): Promise<TrustLevelValue | null>;
  updateTrustLevel(deviceId: string, trustLevel: TrustLevelValue): Promise<void>;
}
