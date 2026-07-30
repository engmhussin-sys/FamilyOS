export interface IUserProfile {
  id: string;
  email: string;
  fullName: string;
  phone: string | null;
  locale: string;
  timezone: string;
}

export interface IUpdateProfileInput {
  fullName?: string;
  phone?: string;
  locale?: string;
  timezone?: string;
}

export const PROFILE_REPOSITORY = Symbol('PROFILE_REPOSITORY');

export interface IProfileRepository {
  findById(userId: string): Promise<IUserProfile | null>;
  update(userId: string, input: IUpdateProfileInput): Promise<IUserProfile>;
}
