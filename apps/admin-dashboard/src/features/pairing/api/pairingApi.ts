import { httpClient } from '../../../shared/lib/httpClient';
import type { PairingInitiateResponse } from '../../../shared/types/api';

/**
 * Sprint 9 (Final Architecture Review) CRITICAL FIX: this used to call
 * the deprecated `/auth/devices/pairing/initiate` endpoint
 * (`docs/architecture/pairing-module-boundary.md` \u00a75: "Deprecated, not
 * removed"). The Child App (Sprint 3 onward) has always called the NEW
 * PairingModule's `/pairing/accept` to redeem a code \u2014 but the old and
 * new pairing flows store invitation codes under different Redis key
 * prefixes with no shared state. This meant every code a parent
 * generated through this Dashboard was UNREDEEMABLE by the real Child
 * App \u2014 pairing has been broken end-to-end since Sprint 3, undetected
 * because no integration test exercises the Dashboard\u2192Child App
 * pairing flow together. Fixed by calling the correct, current endpoint.
 */
export const pairingApi = {
  initiate(childId: string): Promise<PairingInitiateResponse> {
    return httpClient<PairingInitiateResponse>('/pairing/invite', {
      method: 'POST',
      body: { childId },
    });
  },
};
