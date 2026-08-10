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
}
