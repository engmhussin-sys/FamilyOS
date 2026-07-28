import { create } from 'zustand';
import { authApi, type LoginInput, type RegisterInput } from '../api/authApi';
import { tokenStorage, SESSION_EXPIRED_EVENT } from '../../../shared/lib/tokenStorage';
import type { AuthenticatedUser } from '../../../shared/types/api';

interface AuthState {
  user: AuthenticatedUser | null;
  status: 'idle' | 'authenticated' | 'guest';
  error: string | null;
  login: (input: LoginInput) => Promise<void>;
  register: (input: RegisterInput) => Promise<void>;
  logout: () => Promise<void>;
  clearError: () => void;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  // On module load, trust a persisted profile+refresh-token pair
  // optimistically as "authenticated" — the next API call will trigger a
  // real refresh via httpClient's 401 interceptor if the refresh token has
  // actually expired, at which point SESSION_EXPIRED_EVENT corrects this.
  user: tokenStorage.getProfile(),
  status: tokenStorage.hasPersistedSession() ? 'authenticated' : 'guest',
  error: null,

  async login(input) {
    set({ error: null });
    try {
      const { user, tokens } = await authApi.login(input);
      tokenStorage.setSession(user, tokens.accessToken, tokens.refreshToken);
      set({ user, status: 'authenticated' });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Login failed.' });
      throw err;
    }
  },

  async register(input) {
    set({ error: null });
    try {
      await authApi.register(input);
      // Registration does not issue tokens (see backend AuthService.register) —
      // log in immediately afterward so the flow feels like one step to the user.
      await get().login({ email: input.email, password: input.password });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Registration failed.' });
      throw err;
    }
  },

  async logout() {
    const refreshToken = tokenStorage.getRefreshToken();
    if (refreshToken) {
      // Best-effort server-side revocation, using the still-present access
      // token — must happen BEFORE clearing local storage below, since the
      // /auth/logout endpoint requires a valid Authorization header.
      await authApi.logout(refreshToken).catch(() => undefined);
    }
    tokenStorage.clear();
    set({ user: null, status: 'guest', error: null });
  },

  clearError() {
    set({ error: null });
  },
}));

// Wire the transport-layer event (no framework dependency in httpClient)
// to the store's state, once, at module load.
window.addEventListener(SESSION_EXPIRED_EVENT, () => {
  useAuthStore.setState({ user: null, status: 'guest' });
});
