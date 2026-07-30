import 'package:dio/dio.dart';

import '../config/app_config.dart';
import '../storage/secure_session_storage.dart';
import 'api_exception.dart';

/// Parent App's HTTP client. Mirrors the exact refresh-and-retry design
/// of apps/child-app/lib/core/network/api_client.dart and
/// apps/admin-dashboard/src/shared/lib/httpClient.ts — same
/// coordinated-single-refresh-on-401 behavior, applied here to
/// USER-actor tokens (`POST /auth/refresh`) instead of DEVICE-actor ones.
class ApiClient {
  ApiClient(this._sessionStorage, {Dio? dio, void Function()? onSessionExpired})
      : _onSessionExpired = onSessionExpired,
        _dio = dio ??
            Dio(BaseOptions(
              baseUrl: AppConfig.apiBaseUrl,
              // PRODUCTION READINESS REVIEW FINDING: no timeout was
              // configured at all — a hung request (dead connection,
              // server not responding) would wait indefinitely with no
              // error ever surfaced to the UI, leaving a screen stuck
              // on its loading state forever. 15s connect / 20s receive
              // chosen to comfortably exceed the AI recommendation
              // endpoint's own worst case (the backend's Anthropic
              // provider timeout is 20s — see anthropic-ai-provider.ts)
              // without making the user wait unreasonably long for an
              // error on a genuinely dead connection.
              connectTimeout: const Duration(seconds: 15),
              receiveTimeout: const Duration(seconds: 20),
            )) {
    _dio.interceptors.add(
      InterceptorsWrapper(
        onRequest: (options, handler) async {
          if (options.extra['skipAuth'] != true) {
            final token = await _sessionStorage.getAccessToken();
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
            await _sessionStorage.clear();
            _onSessionExpired?.call();
          }
          handler.next(error);
        },
      ),
    );
  }

  final Dio _dio;
  final SecureSessionStorage _sessionStorage;
  final void Function()? _onSessionExpired;
  Future<String?>? _refreshCompleter;

  Future<String?> _refreshAccessToken() {
    return _refreshCompleter ??= _doRefresh().whenComplete(() => _refreshCompleter = null);
  }

  Future<String?> _doRefresh() async {
    final refreshToken = await _sessionStorage.getRefreshToken();
    if (refreshToken == null) return null;

    try {
      final response = await _dio.post(
        '/auth/refresh',
        data: {'refreshToken': refreshToken},
        options: Options(extra: {'skipAuth': true}),
      );
      final newAccessToken = response.data['accessToken'] as String;
      final newRefreshToken = response.data['refreshToken'] as String;
      await _sessionStorage.saveTokens(accessToken: newAccessToken, refreshToken: newRefreshToken);
      return newAccessToken;
    } catch (_) {
      return null;
    }
  }

  Future<Map<String, dynamic>> get(String path, {Map<String, dynamic>? queryParameters}) async {
    return _unwrap(() => _dio.get(path, queryParameters: queryParameters));
  }

  Future<Map<String, dynamic>> post(String path, {Object? data, bool skipAuth = false}) async {
    return _unwrap(() => _dio.post(path, data: data, options: Options(extra: {'skipAuth': skipAuth})));
  }

  Future<Map<String, dynamic>> patch(String path, {Object? data}) async {
    return _unwrap(() => _dio.patch(path, data: data));
  }

  Future<Map<String, dynamic>> _unwrap(Future<Response> Function() call) async {
    try {
      final response = await call();
      return response.data is Map<String, dynamic> ? response.data as Map<String, dynamic> : {'data': response.data};
    } on DioException catch (e) {
      if (e.type == DioExceptionType.connectionTimeout || e.type == DioExceptionType.receiveTimeout) {
        throw ApiException('The request took too long. Check your connection and try again.');
      }
      if (e.type == DioExceptionType.connectionError) {
        throw ApiException('No internet connection.');
      }
      final body = e.response?.data;
      final message = (body is Map && body['message'] != null) ? body['message'].toString() : 'Network error.';
      final correlationId = (body is Map) ? body['correlationId']?.toString() : null;
      throw ApiException(message, statusCode: e.response?.statusCode, correlationId: correlationId);
    }
  }
}
