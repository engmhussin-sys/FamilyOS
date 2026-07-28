import { httpClient } from '../../../shared/lib/httpClient';
import type { DeviceHealthDiagnosis, DeviceSummary } from '../../../shared/types/api';

export const DEVICES_QUERY_KEY = ['devices'] as const;
export const deviceHealthQueryKey = (deviceId: string) => ['device-health', deviceId] as const;

export const devicesApi = {
  list(): Promise<DeviceSummary[]> {
    return httpClient<DeviceSummary[]>('/pairing/devices');
  },

  getHealth(deviceId: string): Promise<DeviceHealthDiagnosis> {
    return httpClient<DeviceHealthDiagnosis>(`/ai-core/device-health/${deviceId}`);
  },

  revoke(deviceId: string, reason?: string): Promise<void> {
    return httpClient<void>('/pairing/revoke', { method: 'POST', body: { deviceId, reason } });
  },
};
