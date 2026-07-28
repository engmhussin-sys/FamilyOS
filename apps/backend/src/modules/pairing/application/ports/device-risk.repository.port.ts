import type { IRiskAssessmentRecord, IRiskAssessmentResult } from '../../domain/risk.types';

export const RISK_SIGNAL_PROVIDER = Symbol('RISK_SIGNAL_PROVIDER');

export const DEVICE_RISK_REPOSITORY = Symbol('DEVICE_RISK_REPOSITORY');

export interface IRecordRiskAssessmentInput extends IRiskAssessmentResult {
  deviceId: string;
}

export interface IDeviceRiskRepository {
  /** Append-only write — never an update (Decision-039's category rule). */
  record(input: IRecordRiskAssessmentInput): Promise<IRiskAssessmentRecord>;
  findLatestByDevice(deviceId: string): Promise<IRiskAssessmentRecord | null>;
  findHistoryByDevice(deviceId: string): Promise<IRiskAssessmentRecord[]>;
}
