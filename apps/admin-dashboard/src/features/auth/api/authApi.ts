import { httpClient } from '../../../shared/lib/httpClient';
import type { LoginResponse, AuthenticatedUser } from '../../../shared/types/api';

export interface RegisterInput {
  email: string;
  password: string;
  fullName: string;
  familyName?: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

export const authApi = {
  register(input: RegisterInput): Promise<AuthenticatedUser> {
    return httpClient<AuthenticatedUser>('/auth/register', {
      method: 'POST',
      body: input,
      skipAuth: true,
    });
  },

  login(input: LoginInput): Promise<LoginResponse> {
    return httpClient<LoginResponse>('/auth/login', {
      method: 'POST',
      body: input,
      skipAuth: true,
    });
  },

  logout(refreshToken: string): Promise<void> {
    return httpClient<void>('/auth/logout', {
      method: 'POST',
      body: { refreshToken },
    });
  },
};
