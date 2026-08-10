import 'package:dio/dio.dart';

import '../config/app_config.dart';
import '../storage/secure_token_storage.dart';
import 'api_exception.dart';

/// Device-side HTTP client. Deliberately mirrors the refresh-and-retry
/// design of apps/admin-dashboard/src/shared/lib/httpClient.ts:
///   - attaches the device's access token as a Bearer header,
///   - on a 401, performs exactly one coordinated refresh (concurrent
///     401s share the same in-flight refresh, never triggering N
///     refreshes for N simultaneous requests),
///   - retries the original request once with the new token,
///   - on refresh failure, clears the session and rethrows — the caller
///     (Step 3: Device Registration / re-pairing flow) is responsible for
///     what happens next; this class only owns the HTTP contract.
///
/// Unlike the backend's own `/auth/refresh`, which is shared between USER
/// and DEVICE actors, this client is ONLY ever used for DEVICE-actor
/// tokens — the Child Agent never authenticates as a parent User.
class ApiClient {
  /// [dio] is injectable for tests (e.g. with a fake `HttpClientAdapter`)
  /// — defaults to a real client configured with [AppConfig.apiBaseUrl].
  /// Without this seam, the refresh-and-retry interceptor logic below
  /// would only be exercisable via a real network call, which is exactly
  /// the kind of untestable design this project avoids elsewhere (see
  /// every backend service's repository-port pattern).
  ApiClient(this._tokenStorage, {Dio? dio})
      : _dio = dio ?? Dio(BaseOptions(baseUrl: AppConfig.apiBaseUrl)) {
    _dio.interceptors.add(
      InterceptorsWrapper(
        onRequest: (options, handler) async {
          if (options.extra['skipAuth'] != true) {
            final token = await _tokenStorage.getAccessToken();
            if (token != null) {
              options.headers['Authorization'] = 'Bearer $token';
            }
          }
          handler.next(options);
        },
        onError: (error, handler) async {
          final isUnauthorized = error.response?.statusCode == 401;
          final alreadyRetried = error.requestOptions.extra['retried'] == true;
          final skipAuth = error.requestOptions.extra['skipAuth'] == true;

          if (isUnauthorized && !alreadyRetried && !skipAuth) {
            final newAccessToken = await _refreshAccessToken();
            if (newAccessToken != null) {
              final retryOptions = error.requestOptions
                ..extra['retried'] = true
                ..headers['Authorization'] = 'Bearer $newAccessToken';
              try {
                final response = await _dio.fetch(retryOptions);
                return handler.resolve(response);
              } on DioException catch (retryError) {
                return handler.next(retryError);
              }
            }
            // Refresh failed: the session is dead. Clear tokens (but keep
            // deviceId — see SecureTokenStorage docstring) so the app can
            // detect "needs re-pairing" state on next launch.
            await _tokenStorage.clearSessionButKeepDeviceId();
          }
          handler.next(error);
        },
      ),
    );
  }

  final Dio _dio;
  final SecureTokenStorage _tokenStorage;

  // Ensures concurrent 401s across multiple in-flight requests trigger
  // exactly one refresh call, matching the same single-flight guarantee
  // as the Admin Dashboard's httpClient.ts.
  Future<String?>? _refreshInFlight;

  Future<String?> _refreshAccessToken() {
    return _refreshInFlight ??= _doRefresh().whenComplete(() {
      _refreshInFlight = null;
    });
  }

  Future<String?> _doRefresh() async {
    final refreshToken = await _tokenStorage.getRefreshToken();
    if (refreshToken == null) return null;

    try {
      final response = await _dio.post(
        '/auth/refresh',
        data: {'refreshToken': refreshToken},
        options: Options(extra: {'skipAuth': true}),
      );
      final newAccessToken = response.data['accessToken'] as String;
      final newRefreshToken = response.data['refreshToken'] as String;
      await _tokenStorage.updateAccessToken(newAccessToken);
      await _tokenStorage.updateRefreshToken(newRefreshToken);
      return newAccessToken;
    } on DioException {
      return null;
    }
  }

  Future<Map<String, dynamic>> get(String path) async {
    try {
      final response = await _dio.get(path);
      return response.data as Map<String, dynamic>;
    } on DioException catch (e) {
      throw _toApiException(e);
    }
  }

  /// ADDITIVE (Sprint 29): [get] above strictly casts the response as
  /// a Map, which throws at runtime for any endpoint that returns a
  /// JSON array (e.g. `/life-intelligence/self/habits`). This is that
  /// missing case \u2014 same auth/refresh/retry interceptor path, just a
  /// different response shape.
  Future<List<dynamic>> getList(String path) async {
    try {
      final response = await _dio.get(path);
      return response.data as List<dynamic>;
    } on DioException catch (e) {
      throw _toApiException(e);
    }
  }

  Future<Map<String, dynamic>> post(
    String path, {
    Map<String, dynamic>? body,
    bool skipAuth = false,
  }) async {
    try {
      final response = await _dio.post(
        path,
        data: body,
        options: Options(extra: {'skipAuth': skipAuth}),
      );
      return response.data as Map<String, dynamic>;
    } on DioException catch (e) {
      throw _toApiException(e);
    }
  }

  /// Sprint 3 — a third auth mode, distinct from both the stored-session
  /// path and `skipAuth`: sends a ONE-TIME caller-supplied token (the
  /// Registration Token, `RegistrationTokenService`'s single-use bearer
  /// token) instead of whatever is in `SecureTokenStorage`. Marked
  /// `skipAuth: true` internally so the request interceptor doesn't
  /// overwrite this header with the stored access token, and so the
  /// 401 interceptor doesn't attempt a refresh cycle that makes no sense
  /// for a token that was never a session token to begin with.
  Future<Map<String, dynamic>> postWithBearerToken(
    String path,
    String token, {
    Map<String, dynamic>? body,
  }) async {
    try {
      final response = await _dio.post(
        path,
        data: body,
        options: Options(
          headers: {'Authorization': 'Bearer $token'},
          extra: {'skipAuth': true},
        ),
      );
      return response.data as Map<String, dynamic>;
    } on DioException catch (e) {
      throw _toApiException(e);
    }
  }

  ApiException _toApiException(DioException e) {
    final statusCode = e.response?.statusCode ?? 0;
    final data = e.response?.data;
    final message = (data is Map && data['message'] != null)
        ? (data['message'] is List ? (data['message'] as List).join(' ') : data['message'].toString())
        : e.message ?? 'Request failed.';
    return ApiException(message, statusCode);
  }
}
