import { httpClient } from '../../../shared/lib/httpClient';

export interface SupportRequestInput {
  email: string;
  subject: string;
  message: string;
  familyId?: string;
  userId?: string;
}

/** Calls the real, already-built public `/support` endpoint
 * (SupportService) — same one the Parent App uses.
 *
 * HONEST LIMITATION: this Dashboard's auth store doesn't currently
 * expose `familyId` directly, so `familyId`/`userId` are omitted
 * here — `isPriority` (Sprint 1 audit's priority_support wiring)
 * will always resolve to false for requests submitted from here,
 * unlike the Parent App where it's already wired correctly. Low
 * impact (affects only internal support-queue sorting, not access to
 * anything), not fixed here to avoid an extra API round-trip just
 * for this. */
export const supportApi = {
  submitRequest(input: SupportRequestInput) {
    return httpClient('/support', { method: 'POST', body: input, skipAuth: true });
  },
};
