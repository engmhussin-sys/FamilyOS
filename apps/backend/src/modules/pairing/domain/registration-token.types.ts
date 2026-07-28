export interface IIssueRegistrationTokenInput {
  childId: string;
  familyId: string;
}

export interface IRegistrationTokenTicket {
  token: string;
  expiresInSeconds: number;
}

export interface IConsumedRegistrationToken {
  childId: string;
  familyId: string;
}
