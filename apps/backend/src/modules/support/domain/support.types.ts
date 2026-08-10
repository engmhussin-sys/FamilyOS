/** Sprint 6 (Support) — domain types. Deliberately minimal: a support
 * request is submit-and-record today, not a full ticketing workflow
 * (no status field, no assignment, no reply thread) — see the
 * schema's own SupportRequest docstring for why that's a conscious
 * scope decision, not an oversight. */

export interface ICreateSupportRequestInput {
  familyId: string | null;
  userId: string | null;
  email: string;
  subject: string;
  message: string;
  isPriority: boolean;
}

export interface ISupportRequestRecord {
  id: string;
  familyId: string | null;
  userId: string | null;
  email: string;
  subject: string;
  message: string;
  isPriority: boolean;
  createdAt: Date;
}

export const SUPPORT_REQUEST_REPOSITORY = Symbol('SUPPORT_REQUEST_REPOSITORY');

export interface ISupportRequestRepository {
  create(input: ICreateSupportRequestInput): Promise<ISupportRequestRecord>;
  /** CLOSES A CRITICAL GAP found during a proactive business audit:
   * the support module could receive requests but had NO way for the
   * team to ever read them back — a write-only system a real team
   * could not actually use. Priority requests sorted first, then
   * newest first within each group. */
  listAll(limit: number): Promise<ISupportRequestRecord[]>;
}
