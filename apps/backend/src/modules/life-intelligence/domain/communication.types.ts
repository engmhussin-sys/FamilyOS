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
  /**
   * PHASE F1 — THE NOTIFICATION PAYLOAD, AND THE REASON A MESSAGE CARD IS
   * TAPPABLE AT ALL.
   *
   * Today it holds exactly one key — `deepLink`, an `abny://<surface>[/<id>]`
   * destination resolved by `notification-destination.ts` and narrowed to that
   * single key by `childSafeNotificationPayload` before it is ever written. The
   * SAME shape under the SAME spelling as the parent's `notifications.data`, so
   * one decision cannot render two ways in two apps.
   *
   * IT IS PART OF THE CHILD-FACING CONTRACT: `GET /life-intelligence/self/messages`
   * serves this field to the child's own device, and
   * `deepLinkFromNotification` in the child app reads it off the row. It
   * therefore carries NO `familyId`, NO `childId`, NO `deviceId` and no token —
   * a deep link is a destination, not a capability, and the server
   * re-authorizes on the next call whatever the link claims.
   *
   * `null` FOR A PARENT-AUTHORED MESSAGE, which names no destination, and for
   * every row written before this column existed. That is a real answer rather
   * than a missing one: the child app renders a payload-less row as
   * NON-TAPPABLE, and nothing backfills a guess into it — a link that opens the
   * wrong screen is worse than a card that is not tappable.
   */
  data: Record<string, unknown> | null;
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
  /**
   * PHASE F1 — the payload written to `child_messages.data`. See
   * `IChildMessage.data` for the contract and for why it is one whitelisted
   * key. Absent (`undefined`) and `null` mean the same thing to the writer —
   * the column stays NULL — because «a human wrote this» and «this producer
   * carried no destination» are both «this row has nowhere to go».
   */
  data?: Record<string, unknown> | null;
}
