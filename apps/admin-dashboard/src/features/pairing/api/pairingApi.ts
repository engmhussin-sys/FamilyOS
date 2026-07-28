import { httpClient } from '../../../shared/lib/httpClient';
import type { PairingInitiateResponse } from '../../../shared/types/api';

export const pairingApi = {
  initiate(childId: string): Promise<PairingInitiateResponse> {
    return httpClient<PairingInitiateResponse>('/auth/devices/pairing/initiate', {
      method: 'POST',
      body: { childId },
    });
  },
};
