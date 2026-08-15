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

  /// B6 ADDITIVE: [get] wraps a non-Map body as `{'data': body}`, which every
  /// existing array-returning caller then unpacks by hand. The F4 surface has
  /// nine array endpoints, so this returns the list directly instead of making
  /// nine call sites repeat the same cast. Same interceptor path, same
  /// refresh-and-retry, same error translation — only the return shape differs.
  Future<List<dynamic>> getList(String path, {Map<String, dynamic>? queryParameters}) async {
    final result = await _unwrap(() => _dio.get(path, queryParameters: queryParameters));
    final data = result['data'];
    if (data is List) return data;
    // A Map body where a List was expected is a real contract break, not
    // something to paper over with an empty list.
    throw ApiException(
      'Expected a JSON array from $path.',
      messageAr: 'وصل ردٌّ غير متوقَّع من الخادم.',
      code: 'CLIENT_UNEXPECTED_SHAPE',
    );
  }

  Future<Map<String, dynamic>> post(String path, {Object? data, bool skipAuth = false}) async {
    return _unwrap(() => _dio.post(path, data: data, options: Options(extra: {'skipAuth': skipAuth})));
  }

  Future<Map<String, dynamic>> patch(String path, {Object? data}) async {
    return _unwrap(() => _dio.patch(path, data: data));
  }

  /// CLOSES A REAL GAP: ApiClient had no HTTP DELETE method at all
  /// until AccountDeletionService needed one. A 204 response (this
  /// codebase's own convention for a destructive-but-successful
  /// action) has a null body — `_unwrap` already handles that safely,
  /// wrapping it as `{'data': null}` rather than throwing.
  Future<Map<String, dynamic>> delete(String path, {Object? data}) async {
    return _unwrap(() => _dio.delete(path, data: data));
  }

  Future<Map<String, dynamic>> _unwrap(Future<Response> Function() call) async {
    try {
      final response = await call();
      return response.data is Map<String, dynamic> ? response.data as Map<String, dynamic> : {'data': response.data};
    } on DioException catch (e) {
      if (e.type == DioExceptionType.connectionTimeout || e.type == DioExceptionType.receiveTimeout) {
        throw ApiException(
          'The request took too long. Check your connection and try again.',
          messageAr: 'استغرق الطلب وقتًا طويلًا. تحقّق من اتصالك وحاول مجددًا.',
          code: 'CLIENT_TIMEOUT',
        );
      }
      if (e.type == DioExceptionType.connectionError) {
        throw ApiException(
          'No internet connection.',
          messageAr: 'لا يوجد اتصال بالإنترنت.',
          code: 'CLIENT_OFFLINE',
        );
      }
      throw _fromErrorEnvelope(e);
    }
  }

  /// B6 — READS THE B3 GLOBAL ERROR CONTRACT.
  ///
  /// The three fields B3 added (`code`, `messageAr`, `details` — plus
  /// `requestId`, which carries the same value as the pre-existing
  /// `correlationId`) were on the wire from commit `f57639c` onwards and no
  /// client read any of them. That is the whole of audit PA-M-002's remaining
  /// half: the Arabic non-punitive sentence existed, was tested, was
  /// serialised, and was thrown away one layer before a human.
  ///
  /// DEFENSIVE ON PURPOSE. Nothing here assumes the envelope is present: an
  /// error from a proxy, a 502 HTML page, or any pre-B3 route still produces a
  /// usable [ApiException] with `messageAr == null`, which `ApiFailure`
  /// renders by falling back to `message`.
  ApiException _fromErrorEnvelope(DioException e) {
    final body = e.response?.data;
    if (body is! Map) {
      return ApiException(
        e.message ?? 'Network error.',
        statusCode: e.response?.statusCode,
      );
    }

    // `message` is a String for a hand-thrown exception and a String[] for a
    // ValidationPipe failure — B3 preserved both shapes deliberately.
    final rawMessage = body['message'];
    final message = rawMessage is List
        ? rawMessage.join(' ')
        : (rawMessage?.toString() ?? 'Network error.');

    final rawDetails = body['details'];
    return ApiException(
      message,
      statusCode: e.response?.statusCode,
      correlationId: body['correlationId']?.toString(),
      requestId: body['requestId']?.toString() ?? body['correlationId']?.toString(),
      code: body['code']?.toString(),
      messageAr: body['messageAr']?.toString(),
      details: rawDetails is Map ? Map<String, dynamic>.from(rawDetails) : null,
    );
  }
}
