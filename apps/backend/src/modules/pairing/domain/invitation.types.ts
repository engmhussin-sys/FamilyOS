export interface ICreateInvitationInput {
  childId: string;
  familyId: string;
  initiatedByUserId: string;
}

export interface IInvitationTicket {
  code: string;
  expiresInSeconds: number;
}

export interface IRedeemedInvitation {
  childId: string;
  familyId: string;
  initiatedByUserId: string;
}
