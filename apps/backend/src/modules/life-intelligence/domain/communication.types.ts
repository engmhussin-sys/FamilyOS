export type MessageAuthorType = 'PARENT' | 'AI';
export type MessageApprovalStatus = 'NOT_REQUIRED' | 'PENDING' | 'APPROVED' | 'REJECTED';

export interface IChildMessage {
  id: string;
  childId: string;
  fromUserId: string | null;
  authorType: MessageAuthorType;
  approvalStatus: MessageApprovalStatus;
  category: string;
  title: string;
  body: string;
  deliveredAt: Date | null;
  acknowledgedAt: Date | null;
}

export interface ISendChildMessageInput {
  childId: string;
  fromUserId?: string;
  authorType: MessageAuthorType;
  category: string;
  title: string;
  body: string;
  /**
   * B9 (PA-B-007 / PA-B-008) — the CHILD half of the notification surface.
   *
   * `SmartNotificationIntegrationService.deliver` routes PARENT candidates to
   * `notifications` and CHILD candidates HERE, so a child-targeted
   * notification is a `child_messages` row and carried exactly the same
   * duplicate exposure — with no five-minute window in front of it at all.
   *
   * OPTIONAL here, unlike the parent side, and the asymmetry is deliberate
   * rather than an oversight: this table also carries PARENT-AUTHORED
   * messages, which are caused by no event and must NEVER be deduplicated — a
   * parent may send «أحسنت» twice on purpose, and refusing the second one
   * would be a product defect. `undefined` means «a human wrote this»;
   * PostgreSQL treats NULLs as distinct in a unique index, so
   * `child_messages (family_id, source_event_id)` binds exactly the
   * machine-generated rows and leaves the human ones alone.
   */
  sourceEventId?: string;
}
