import 'package:dio/dio.dart';
import 'package:http_parser/http_parser.dart';

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
          // WRAPPED, AND NOT DEFENSIVELY. An `onRequest` callback that throws
          // never calls its handler, so the `RequestInterceptorHandler`'s future
          // never completes and the caller's `await` hangs FOREVER — there is no
          // exception to catch and no timeout to hit. `flutter_secure_storage`
          // reads the Android Keystore and does throw `PlatformException` on a
          // corrupted or migrated keystore, so this is a real device failure,
          // not a hypothetical one. Sending the request WITHOUT the header is
          // the honest degradation: the server answers 401 and the app takes
          // its normal "session is dead" path instead of freezing mid-upload.
          if (options.extra['skipAuth'] != true) {
            try {
              final token = await _tokenStorage.getAccessToken();
              if (token != null) {
                options.headers['Authorization'] = 'Bearer $token';
              }
            } catch (_) {
              // Intentionally unauthenticated. See above.
            }
          }
          handler.next(options);
        },
        onError: (error, handler) async {
          final isUnauthorized = error.response?.statusCode == 401;
          final alreadyRetried = error.requestOptions.extra['retried'] == true;
          final skipAuth = error.requestOptions.extra['skipAuth'] == true;

          if (isUnauthorized && !alreadyRetried && !skipAuth) {
            // THE SAME "A THROWN INTERCEPTOR HANGS THE CALLER" RULE AS ABOVE,
            // and this branch has four ways to throw something that is NOT a
            // `DioException`: the Keystore reads and writes inside the refresh,
            // the JSON shape of the refresh response, `FormData.clone()` (a
            // `StateError` for a part that cannot be rebuilt), and the retry
            // itself. Every one of them used to escape past `handler`, and the
            // evidence upload is exactly where that is worst: the controller
            // sits in `EvidencePhase.uploading` forever, the card's spinner
            // never stops, and `clearEvidence()` refuses to act while
            // `isUploading` is true — so the child is left on a frozen screen
            // with no error, no retry and no way out.
            //
            // Anything unexpected therefore falls through to `handler.next` at
            // the end of this callback with the ORIGINAL 401, which the caller
            // already knows how to translate («سجّل دخولك تاني» via the B3
            // envelope) — never swallowed, never silently succeeded.
            try {
              final newAccessToken = await _refreshAccessToken();
              if (newAccessToken != null) {
                final retryOptions = error.requestOptions
                  ..extra['retried'] = true
                  ..headers['Authorization'] = 'Bearer $newAccessToken';
                // F1 — A MULTIPART BODY CANNOT BE REPLAYED, AND THIS IS WHERE
                // THAT WOULD HAVE BITTEN.
                //
                // `FormData` is single-use: Dio finalises it into a stream on
                // the first send and a second `fetch` of the same
                // `RequestOptions` throws a StateError, which is NOT a
                // DioException — so `_toApiException` never sees it and the
                // caller gets a raw client-side crash. That is precisely the
                // shape of the 401-then-retry path this interceptor exists for,
                // and the 15 MiB evidence upload is the app's only multipart
                // request, so the case is not hypothetical: a child whose
                // access token expired mid-recitation-upload would have hit it
                // every time. `clone()` rebuilds the parts, which is Dio's own
                // documented answer.
                //
                // AND CLONING THE ENVELOPE IS ONLY HALF OF IT. A cloned
                // `FormData` holding a part whose bytes were already consumed
                // is just as exhausted as the original — `MultipartFile.clone()`
                // copies the part's DATA SOURCE, not its data, so the retry is
                // only re-readable if that source can be opened twice. It can:
                // [postMultipart] builds its one part with
                // `MultipartFile.fromFile(path)`, which dio backs with a
                // `() => File(path).openRead()` builder, so the clone re-opens
                // the file from disk. That is the invariant the whole retry
                // rests on, it is not visible at this line, and
                // `test/core/network/api_client_multipart_retry_test.dart`
                // exists to fail the moment a stream-backed part is introduced
                // here instead.
                final body = retryOptions.data;
                if (body is FormData) {
                  retryOptions.data = body.clone();
                }
                final response = await _dio.fetch(retryOptions);
                return handler.resolve(response);
              }
              // Refresh failed: the session is dead. Clear tokens (but keep
              // deviceId — see SecureTokenStorage docstring) so the app can
              // detect "needs re-pairing" state on next launch.
              await _tokenStorage.clearSessionButKeepDeviceId();
            } on DioException catch (retryError) {
              return handler.next(retryError);
            } catch (_) {
              // A Keystore failure, an unexpected refresh body, a part that
              // cannot be rebuilt. The 401 the server actually sent is the
              // truthful thing to hand back.
              return handler.next(error);
            }
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

  /// NEVER THROWS, AND THAT IS THE CONTRACT. Its only caller is inside an
  /// error interceptor, where an escaping error is not an error the app can
  /// report — it is a `Future` that never completes (see the `onError` note).
  ///
  /// `null` means «no new access token», which is the one answer the caller
  /// knows how to act on. The three ways this used to throw instead:
  ///   * `_tokenStorage` reads/writes — Android Keystore, `PlatformException`;
  ///   * `response.data['accessToken'] as String` — a `TypeError` for ANY body
  ///     that is not a Map with two string fields (a proxy's HTML error page,
  ///     a 204, a shape change);
  ///   * `response.data['...']` itself — `NoSuchMethodError` on a `List` body.
  /// The checked reads below replace the casts: a body that does not carry
  /// both tokens is a failed refresh, not a crash.
  Future<String?> _doRefresh() async {
    try {
      final refreshToken = await _tokenStorage.getRefreshToken();
      if (refreshToken == null) return null;

      final response = await _dio.post(
        '/auth/refresh',
        data: {'refreshToken': refreshToken},
        options: Options(extra: {'skipAuth': true}),
      );
      final data = response.data;
      if (data is! Map) return null;
      final newAccessToken = data['accessToken'];
      final newRefreshToken = data['refreshToken'];
      if (newAccessToken is! String ||
          newAccessToken.isEmpty ||
          newRefreshToken is! String ||
          newRefreshToken.isEmpty) {
        return null;
      }
      await _tokenStorage.updateAccessToken(newAccessToken);
      await _tokenStorage.updateRefreshToken(newRefreshToken);
      return newAccessToken;
    } catch (_) {
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

  /// FOR A ROUTE THAT ANSWERS 204 BY CONTRACT — no cast, because there is no
  /// body to cast.
  ///
  /// [post] above ends in `response.data as Map<String, dynamic>`. A 204 has
  /// an empty body, which Dio surfaces as `null` or `''` depending on its
  /// transformer, and either one makes that cast throw a `TypeError` — a
  /// failure that is NOT a `DioException`, so `_toApiException` never sees it
  /// and the caller is handed a client-side crash for a request the server
  /// completed. Every caller that has one of these today
  /// (`heartbeat`, `reportCapabilities`, `verify`) is fire-and-forget and
  /// swallows whatever it gets, which is exactly why the shape has never been
  /// noticed; the push-token registration below is NOT fire-and-forget (it
  /// records what it sent so it never re-sends it), so it cannot inherit that
  /// ambiguity. Same interceptor path, same refresh-and-retry, same error
  /// translation — only the unread body differs.
  ///
  /// NOT VERIFIED AT RUNTIME: no Dart SDK exists in this environment, so which
  /// of `null`/`''` Dio actually produces was read from its documented
  /// behaviour, not observed. This method is correct under both.
  Future<void> postNoContent(
    String path, {
    Map<String, dynamic>? body,
  }) async {
    try {
      await _dio.post(path, data: body);
    } on DioException catch (e) {
      throw _toApiException(e);
    }
  }

  /// THE [post] EQUIVALENT OF [getList], AND IT CLOSES A LIVE DEFECT.
  ///
  /// [post] above casts the body to a Map, exactly as [get] did before
  /// [getList] existed. `POST /life-intelligence/self/smart-tasks/generate`
  /// returns a bare JSON **array** (`return this.smartTaskEngine
  /// .listForToday(...)`), so the cast on line above threw a `TypeError`
  /// on every single call — and because the only caller wrapped it in a
  /// best-effort `catch`, the smart-task cards silently never rendered.
  /// A response shape mismatch that fails inside a swallow is invisible
  /// twice over, which is why the shape now has its own method instead of
  /// being cast at the call site.
  Future<List<dynamic>> postList(
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
      return response.data as List<dynamic>;
    } on DioException catch (e) {
      throw _toApiException(e);
    }
  }

  /// F1 — THE MULTIPART POST. The app's fourth request shape, and the only
  /// one that sends a file.
  ///
  /// SHAPED LIKE ITS NEIGHBOURS ON PURPOSE: same `_dio`, therefore the same
  /// Bearer header, the same coordinated single refresh on 401 (see the
  /// `FormData.clone()` note in the interceptor, which exists for this method
  /// specifically), the same `_toApiException` translation of the B3 error
  /// envelope. There is no second HTTP client in this app and this did not
  /// add one.
  ///
  /// [contentType] IS NOT COSMETIC AND IS NOT A GUESS. The route is
  /// `FileInterceptor('file', { fileFilter: ... })`, and multer DROPS any
  /// part whose declared Content-Type is outside
  /// `ALLOWED_EVIDENCE_MIME_TYPES` — silently, with a 2xx-shaped request that
  /// then reaches a handler with no file and answers `EVIDENCE_MISSING`
  /// («لم يصل أي ملف»). A caller must therefore pass a type derived from the
  /// bytes (`EvidenceContract.inspect`), never a picker's own claim about the
  /// file, or the child reads "nothing arrived" about a file that did.
  ///
  /// The server re-derives the real type from the bytes regardless and stores
  /// THAT one; this header only gets the part past the door.
  ///
  /// STREAMED FROM [filePath], never read into memory: the ceiling is 15 MiB
  /// and the device is a child's phone.
  Future<Map<String, dynamic>> postMultipart(
    String path, {
    required String fieldName,
    required String filePath,
    required String filename,
    required String contentType,
  }) async {
    try {
      final form = FormData.fromMap(<String, dynamic>{
        fieldName: await MultipartFile.fromFile(
          filePath,
          filename: filename,
          // `MediaType` from http_parser, which is declared in pubspec.yaml
          // rather than reached transitively. Dio's own `DioMediaType` alias
          // would read better and is deliberately not used: it landed in dio
          // 5.5.0, this app pins `dio: ^5.4.3`, and a constraint that MAY
          // resolve below the version an identifier needs is a build that
          // breaks on someone else's machine.
          contentType: MediaType.parse(contentType),
        ),
      });
      final response = await _dio.post(path, data: form);
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

  /// B6 — READS THE B3 GLOBAL ERROR CONTRACT.
  ///
  /// The English `message` extraction below is byte-for-byte the behaviour
  /// that was here before (including the `List` join for a ValidationPipe
  /// body); everything after it is new. That ordering matters: `messageAr`
  /// is ADDED, `message` is not replaced, so any caller still reading
  /// `.message` behaves identically to before this commit.
  ///
  /// The transport cases (`connectionError`, timeouts) get their own codes
  /// and their own Arabic sentences, because a child who is simply offline
  /// must not be shown a server error — and because the server, by
  /// definition, sent nothing to translate.
  ApiException _toApiException(DioException e) {
    if (e.type == DioExceptionType.connectionTimeout ||
        e.type == DioExceptionType.receiveTimeout ||
        e.type == DioExceptionType.sendTimeout) {
      return ApiException(
        'The request took too long.',
        0,
        code: 'CLIENT_TIMEOUT',
        messageAr: 'الاتصال بطيء شوية. جرّب تاني بعد لحظة.',
      );
    }
    if (e.type == DioExceptionType.connectionError) {
      return ApiException(
        'No internet connection.',
        0,
        code: 'CLIENT_OFFLINE',
        messageAr: 'مفيش إنترنت دلوقتي. هنكمّل أول ما يرجع.',
      );
    }

    final statusCode = e.response?.statusCode ?? 0;
    final data = e.response?.data;
    final message = (data is Map && data['message'] != null)
        ? (data['message'] is List ? (data['message'] as List).join(' ') : data['message'].toString())
        : e.message ?? 'Request failed.';
    if (data is! Map) {
      return ApiException(message, statusCode);
    }
    final rawDetails = data['details'];
    return ApiException(
      message,
      statusCode,
      code: data['code']?.toString(),
      messageAr: data['messageAr']?.toString(),
      requestId: data['requestId']?.toString() ?? data['correlationId']?.toString(),
      details: rawDetails is Map ? Map<String, dynamic>.from(rawDetails) : null,
    );
  }
}
