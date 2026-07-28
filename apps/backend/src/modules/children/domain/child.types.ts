export interface ICreateChildInput {
  firstName: string;
  lastName?: string;
  dateOfBirth: string; // ISO date string, e.g. "2015-06-01"
  gender?: string;
  avatarUrl?: string;
}

export interface IUpdateChildInput {
  firstName?: string;
  lastName?: string;
  dateOfBirth?: string;
  gender?: string;
  avatarUrl?: string;
  isActive?: boolean;
}

export interface IChildResponse {
  id: string;
  familyId: string;
  firstName: string;
  lastName: string | null;
  dateOfBirth: string;
  gender: string | null;
  avatarUrl: string | null;
  isActive: boolean;
  createdAt: Date;
}
