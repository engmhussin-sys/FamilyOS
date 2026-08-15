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

  /**
   * B3 — the backend's Global Error Contract. Before it, `GlobalExceptionFilter`
   * erased `code` and `messageAr`, so this client only ever saw
   * `{"message":"Conflict Exception"}` (PA-B-021). These assert the dashboard
   * now carries the new fields through AND that nothing about the old contract
   * changed for the components already reading `.message` / `.statusCode`.
   */
  describe('B3 — the global error contract', () => {
    it('surfaces code, messageAr, requestId and details on the thrown ApiError', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValue(
        jsonResponse(409, {
          statusCode: 409,
          code: 'MAX_PER_DAY_REACHED',
          message: 'This action has already been done, or is not available right now.',
          messageAr: 'أكملت هذا البرنامج مرة اليوم — وهذا هو الحد اليومي. نراك غدًا!',
          details: {},
          requestId: 'f0e1d2c3-0000-4000-8000-000000000001',
          correlationId: 'f0e1d2c3-0000-4000-8000-000000000001',
        }),
      );

      const err = (await httpClient('/reward-programs/1/start', { method: 'POST' }).catch(
        (e: unknown) => e,
      )) as ApiError;

      expect(err).toBeInstanceOf(ApiError);
      expect(err.code).toBe('MAX_PER_DAY_REACHED');
      expect(err.messageAr).toBe('أكملت هذا البرنامج مرة اليوم — وهذا هو الحد اليومي. نراك غدًا!');
      expect(err.requestId).toBe('f0e1d2c3-0000-4000-8000-000000000001');
      expect(err.details).toEqual({});
      // BACKWARD COMPATIBILITY: unchanged for every component already using it.
      expect(err.statusCode).toBe(409);
      expect(err.message).toBe('This action has already been done, or is not available right now.');
    });

    it('still joins a `string[]` message — the DTO-validation shape is unchanged', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValue(
        jsonResponse(400, {
          statusCode: 400,
          code: 'VALIDATION_FAILED',
          message: ['firstName should not be empty', 'dateOfBirth must be a valid ISO 8601 date string'],
          messageAr: 'تعذّر قبول بعض الحقول المُرسلة. راجعها ثم أعد المحاولة.',
          details: { fields: [{ field: 'firstName', constraints: ['isNotEmpty'] }] },
          requestId: 'r-2',
        }),
      );

      const err = (await httpClient('/children', { method: 'POST' }).catch((e: unknown) => e)) as ApiError;

      expect(err.message).toBe(
        'firstName should not be empty dateOfBirth must be a valid ISO 8601 date string',
      );
      expect(err.code).toBe('VALIDATION_FAILED');
      expect((err.details as { fields: { field: string }[] }).fields[0].field).toBe('firstName');
    });

    it('degrades safely when a response predates B3 or carries none of the new fields', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValue(
        jsonResponse(502, { message: 'Bad Gateway', statusCode: 502 }),
      );

      const err = (await httpClient('/anything').catch((e: unknown) => e)) as ApiError;

      expect(err.message).toBe('Bad Gateway');
      expect(err.code).toBeUndefined();
      expect(err.messageAr).toBeUndefined();
      expect(err.requestId).toBeUndefined();
    });
  });
});
