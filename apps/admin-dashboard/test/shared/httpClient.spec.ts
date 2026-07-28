import { beforeEach, describe, expect, it, vi } from 'vitest';
import { httpClient, ApiError } from '@/shared/lib/httpClient';
import { tokenStorage, SESSION_EXPIRED_EVENT } from '@/shared/lib/tokenStorage';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('httpClient', () => {
  beforeEach(() => {
    tokenStorage.clear();
    vi.restoreAllMocks();
  });

  it('attaches the access token as a Bearer header when one is set', async () => {
    tokenStorage.setAccessToken('access-token-1');
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(jsonResponse(200, { ok: true }));

    await httpClient('/some-path');

    const [, requestInit] = fetchMock.mock.calls[0];
    expect((requestInit?.headers as Record<string, string>).Authorization).toBe(
      'Bearer access-token-1',
    );
  });

  it('does not attach a token when skipAuth is set (e.g. /auth/login)', async () => {
    tokenStorage.setAccessToken('access-token-1');
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(jsonResponse(200, { ok: true }));

    await httpClient('/auth/login', { skipAuth: true });

    const [, requestInit] = fetchMock.mock.calls[0];
    expect((requestInit?.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('on a 401, refreshes once and retries the original request', async () => {
    tokenStorage.setAccessToken('expired-access-token');
    tokenStorage.setRefreshToken('valid-refresh-token');

    const fetchMock = vi
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(jsonResponse(401, { message: 'Unauthorized', statusCode: 401 })) // original request fails
      .mockResolvedValueOnce(
        jsonResponse(200, {
          accessToken: 'new-access-token',
          refreshToken: 'new-refresh-token',
          accessTokenExpiresInSeconds: 900,
          refreshTokenExpiresInSeconds: 2_592_000,
        }),
      ) // /auth/refresh succeeds
      .mockResolvedValueOnce(jsonResponse(200, { data: 'success' })); // retried original request

    const result = await httpClient<{ data: string }>('/protected-resource');

    expect(result).toEqual({ data: 'success' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(tokenStorage.getAccessToken()).toBe('new-access-token');
  });

  it('clears the session and emits SESSION_EXPIRED_EVENT when refresh fails', async () => {
    tokenStorage.setAccessToken('expired-access-token');
    tokenStorage.setRefreshToken('stale-refresh-token');

    vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce(jsonResponse(401, { message: 'Unauthorized', statusCode: 401 }))
      .mockResolvedValueOnce(jsonResponse(401, { message: 'Invalid refresh token', statusCode: 401 }));

    const listener = vi.fn();
    window.addEventListener(SESSION_EXPIRED_EVENT, listener);

    await expect(httpClient('/protected-resource')).rejects.toBeInstanceOf(ApiError);

    expect(listener).toHaveBeenCalledOnce();
    expect(tokenStorage.getAccessToken()).toBeNull();
    expect(tokenStorage.getRefreshToken()).toBeNull();

    window.removeEventListener(SESSION_EXPIRED_EVENT, listener);
  });

  it('propagates non-401 errors without attempting a refresh', async () => {
    tokenStorage.setAccessToken('access-token-1');
    const fetchMock = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(jsonResponse(400, { message: 'Bad input', statusCode: 400 }));

    await expect(httpClient('/some-path')).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1); // no refresh attempt
  });
});
