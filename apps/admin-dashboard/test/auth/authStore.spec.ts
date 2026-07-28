import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tokenStorage } from '@/shared/lib/tokenStorage';

vi.mock('@/features/auth/api/authApi', () => ({
  authApi: {
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
  },
}));

import { authApi } from '@/features/auth/api/authApi';
import { useAuthStore } from '@/features/auth/store/authStore';

const mockUser = {
  id: 'user-1',
  email: 'parent@example.com',
  fullName: 'Test Parent',
  familyId: 'family-1',
  familyRole: 'OWNER' as const,
};

const mockTokens = {
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  accessTokenExpiresInSeconds: 900,
  refreshTokenExpiresInSeconds: 2_592_000,
};

describe('useAuthStore', () => {
  beforeEach(() => {
    tokenStorage.clear();
    useAuthStore.setState({ user: null, status: 'guest', error: null });
    vi.clearAllMocks();
  });

  it('starts as guest with no persisted session', () => {
    expect(useAuthStore.getState().status).toBe('guest');
    expect(useAuthStore.getState().user).toBeNull();
  });

  it('login: persists the session and flips status to authenticated', async () => {
    vi.mocked(authApi.login).mockResolvedValue({ user: mockUser, tokens: mockTokens });

    await useAuthStore.getState().login({ email: mockUser.email, password: 'whatever' });

    expect(useAuthStore.getState().status).toBe('authenticated');
    expect(useAuthStore.getState().user).toEqual(mockUser);
    expect(tokenStorage.getAccessToken()).toBe('access-1');
    expect(tokenStorage.getRefreshToken()).toBe('refresh-1');
  });

  it('login: surfaces the error message and stays a guest on failure', async () => {
    vi.mocked(authApi.login).mockRejectedValue(new Error('Invalid email or password.'));

    await expect(
      useAuthStore.getState().login({ email: 'wrong@example.com', password: 'bad' }),
    ).rejects.toThrow();

    expect(useAuthStore.getState().status).toBe('guest');
    expect(useAuthStore.getState().error).toBe('Invalid email or password.');
  });

  it('register: registers then logs in automatically (register issues no tokens itself)', async () => {
    vi.mocked(authApi.register).mockResolvedValue(mockUser);
    vi.mocked(authApi.login).mockResolvedValue({ user: mockUser, tokens: mockTokens });

    await useAuthStore.getState().register({
      email: mockUser.email,
      password: 'Sup3rSecret!',
      fullName: mockUser.fullName,
    });

    expect(authApi.register).toHaveBeenCalledOnce();
    expect(authApi.login).toHaveBeenCalledWith({
      email: mockUser.email,
      password: 'Sup3rSecret!',
    });
    expect(useAuthStore.getState().status).toBe('authenticated');
  });

  it('logout: clears local session even if the server call fails', async () => {
    tokenStorage.setSession(mockUser, 'access-1', 'refresh-1');
    useAuthStore.setState({ user: mockUser, status: 'authenticated' });
    vi.mocked(authApi.logout).mockRejectedValue(new Error('network error'));

    await useAuthStore.getState().logout();

    expect(useAuthStore.getState().status).toBe('guest');
    expect(useAuthStore.getState().user).toBeNull();
    expect(tokenStorage.getAccessToken()).toBeNull();
  });
});
