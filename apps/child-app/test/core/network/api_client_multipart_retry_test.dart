import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:child_app/core/network/api_client.dart';
import 'package:child_app/core/network/api_exception.dart';
import 'package:child_app/core/storage/secure_token_storage.dart';

/// THE 401-DURING-AN-EVIDENCE-UPLOAD GUARD.
///
/// WHY THIS FILE EXISTS. `ApiClient` retries exactly once after a coordinated
/// token refresh, and the app's ONLY multipart request is the child's
/// achievement evidence — a recitation or a photo, up to 15 MiB, on a cheap
/// phone whose access token expires on its own schedule. A multipart body is
/// single-use: dio finalises a `FormData` into a stream on the first send, so
/// replaying the same instance sends an EXHAUSTED body, and the failure that
/// follows is a `StateError` rather than a `DioException` — it escapes
/// `_toApiException`, escapes the interceptor's handler entirely, and leaves
/// the caller's `Future` hanging with no error at all. On the evidence path
/// that means `EvidencePhase.uploading` forever: a spinner that never stops and
/// a «امسح» button that refuses to act because `isUploading` is still true.
///
/// The interceptor clones the `FormData` for the retry. THAT IS ONLY HALF THE
/// INVARIANT, and the half these tests exist for is the other one: a cloned
/// `FormData` whose part holds an already-consumed stream is just as exhausted
/// as the original. `MultipartFile.clone()` copies a part's DATA SOURCE, not
/// its data, so the retry only carries bytes because
/// `ApiClient.postMultipart` builds its part with `MultipartFile.fromFile`,
/// which dio backs with a re-openable `() => File(path).openRead()` builder.
///
/// So these tests do not assert that `clone()` was called — that is an
/// implementation detail and asserting it would pass just as happily on a body
/// with no bytes in it. They assert the OBSERVABLE fact the child depends on:
/// **the retried request carries the file's bytes.** Swap `fromFile` for a
/// one-shot stream and the first test fails.
///
/// NOT RUN IN THE AUTHORING ENVIRONMENT: there is no Dart/Flutter toolchain
/// there and pub.dev is unreachable, so this file was written and reviewed
/// statically and has never been executed. It runs on a machine with a real
/// SDK, like every other test in this directory.
void main() {
  const fileMarker = 'RECITATION-BYTES-0123456789';

  late Directory tempDir;
  late File evidenceFile;

  setUp(() async {
    tempDir = await Directory.systemTemp.createTemp('abny_evidence_test');
    evidenceFile = File('${tempDir.path}/recitation.m4a');
    // Padded so the part is unambiguously larger than its own headers.
    await evidenceFile.writeAsString('$fileMarker${'.' * 512}');
  });

  tearDown(() async {
    if (tempDir.existsSync()) {
      await tempDir.delete(recursive: true);
    }
  });

  ApiClient buildClient(_RecordingAdapter adapter, FlutterSecureStorage store) {
    final dio = Dio(BaseOptions(baseUrl: 'https://example.invalid/api/v1'));
    dio.httpClientAdapter = adapter;
    return ApiClient(SecureTokenStorage(store), dio: dio);
  }

  Future<Map<String, dynamic>> upload(ApiClient client) => client.postMultipart(
        '/self/achievements/11111111-1111-1111-1111-111111111111/evidence',
        fieldName: 'file',
        filePath: evidenceFile.path,
        filename: 'recitation.m4a',
        contentType: 'audio/mp4',
      );

  test(
      'a 401 mid-upload is retried with a body that STILL CONTAINS THE FILE — '
      'a cloned envelope around a consumed stream would send nothing',
      () async {
    final store = _FakeSecureStorage({
      'afdc.device.accessToken': 'stale-access',
      'afdc.device.refreshToken': 'good-refresh',
    });
    final adapter = _RecordingAdapter(
      onEvidence: (call) => call.attempt == 1
          ? _json(401, {'code': 'TOKEN_EXPIRED', 'message': 'expired'})
          : _json(201, {
              'submissionRef': 'ref-1',
              'kind': 'RECITATION',
              'mimeType': 'audio/mp4',
              'byteSize': 539,
            }),
      onRefresh: (_) => _json(200, {
        'accessToken': 'fresh-access',
        'refreshToken': 'fresh-refresh',
      }),
    );

    final response = await upload(buildClient(adapter, store));

    expect(response['submissionRef'], 'ref-1');
    expect(adapter.evidenceCalls.length, 2,
        reason: 'exactly one retry, never two');

    // THE ASSERTION THIS WHOLE FILE IS FOR.
    expect(adapter.evidenceCalls[0].body, contains(fileMarker));
    expect(adapter.evidenceCalls[1].body, contains(fileMarker),
        reason: 'the retry sent an exhausted body — the file stream was not '
            're-readable, so the server received a part with no bytes');
    expect(adapter.evidenceCalls[1].body, contains('filename="recitation.m4a"'));

    // The retry must also carry the NEW token, and its multipart boundary must
    // match the body it actually sent — dio re-derives the Content-Type from
    // whichever FormData is on the options, so a clone with a stale boundary
    // header would arrive as an unparseable body.
    expect(adapter.evidenceCalls[0].headers['authorization'], 'Bearer stale-access');
    expect(adapter.evidenceCalls[1].headers['authorization'], 'Bearer fresh-access');
    final boundary = adapter.evidenceCalls[1].headers['content-type']!
        .split('boundary=')
        .last;
    expect(adapter.evidenceCalls[1].body, contains(boundary));
  });

  test('a refresh that answers with an unusable body fails LOUDLY and quickly, '
      'never hanging the upload', () async {
    final store = _FakeSecureStorage({
      'afdc.device.accessToken': 'stale-access',
      'afdc.device.refreshToken': 'good-refresh',
    });
    final adapter = _RecordingAdapter(
      onEvidence: (_) => _json(401, {'code': 'TOKEN_EXPIRED', 'message': 'expired'}),
      // A proxy's error page, a shape change, a 204 — anything that is not
      // «two non-empty string tokens». The old code cast this to String and
      // threw a TypeError out of the interceptor, which no caller can catch.
      onRefresh: (_) => _json(200, {'ok': true}),
    );

    await expectLater(
      upload(buildClient(adapter, store)),
      throwsA(isA<ApiException>().having((e) => e.statusCode, 'statusCode', 401)),
    );
    expect(adapter.evidenceCalls.length, 1, reason: 'no retry without a token');
  }, timeout: const Timeout(Duration(seconds: 20)));

  test('a Keystore that throws does not freeze the request — it is sent '
      'unauthenticated and the server decides', () async {
    final adapter = _RecordingAdapter(
      onEvidence: (_) => _json(401, {'code': 'UNAUTHORIZED', 'message': 'no token'}),
      onRefresh: (_) => _json(200, {'accessToken': 'x', 'refreshToken': 'y'}),
    );

    await expectLater(
      upload(buildClient(adapter, _ThrowingSecureStorage())),
      throwsA(isA<ApiException>()),
    );
    expect(adapter.evidenceCalls.first.headers.containsKey('authorization'), isFalse);
  }, timeout: const Timeout(Duration(seconds: 20)));

  test('a retry that is itself refused surfaces the SERVER\'S refusal, not the '
      'first 401', () async {
    final store = _FakeSecureStorage({
      'afdc.device.accessToken': 'stale-access',
      'afdc.device.refreshToken': 'good-refresh',
    });
    final adapter = _RecordingAdapter(
      onEvidence: (call) => call.attempt == 1
          ? _json(401, {'code': 'TOKEN_EXPIRED', 'message': 'expired'})
          : _json(413, {
              'code': 'EVIDENCE_TOO_LARGE',
              'message': 'too large',
              'messageAr': 'الملف كبير شوية.',
            }),
      onRefresh: (_) => _json(200, {
        'accessToken': 'fresh-access',
        'refreshToken': 'fresh-refresh',
      }),
    );

    await expectLater(
      upload(buildClient(adapter, store)),
      throwsA(isA<ApiException>()
          .having((e) => e.statusCode, 'statusCode', 413)
          .having((e) => e.code, 'code', 'EVIDENCE_TOO_LARGE')
          .having((e) => e.messageAr, 'messageAr', 'الملف كبير شوية.')),
    );
    expect(adapter.evidenceCalls[1].body, contains(fileMarker));
  });
}

ResponseBody _json(int statusCode, Map<String, dynamic> body) => ResponseBody.fromString(
      jsonEncode(body),
      statusCode,
      headers: {
        Headers.contentTypeHeader: [Headers.jsonContentType],
      },
    );

/// One request as the wire saw it — the decoded body included, because the
/// body is the whole point.
class _RecordedCall {
  _RecordedCall({required this.attempt, required this.headers, required this.body});

  final int attempt;
  final Map<String, String> headers;
  final String body;
}

/// A dio adapter that DRAINS the request stream before answering, exactly as a
/// real transport does — an adapter that ignored the stream would let an
/// exhausted body pass unnoticed, which is the bug this file guards.
class _RecordingAdapter implements HttpClientAdapter {
  _RecordingAdapter({required this.onEvidence, required this.onRefresh});

  final ResponseBody Function(_RecordedCall call) onEvidence;
  final ResponseBody Function(_RecordedCall call) onRefresh;

  final List<_RecordedCall> evidenceCalls = <_RecordedCall>[];
  final List<_RecordedCall> refreshCalls = <_RecordedCall>[];

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    final bytes = <int>[];
    if (requestStream != null) {
      await for (final chunk in requestStream) {
        bytes.addAll(chunk);
      }
    }
    final headers = <String, String>{};
    options.headers.forEach((key, value) {
      if (value != null) headers[key.toLowerCase()] = value.toString();
    });

    final isRefresh = options.path.contains('/auth/refresh');
    final call = _RecordedCall(
      attempt: (isRefresh ? refreshCalls.length : evidenceCalls.length) + 1,
      headers: headers,
      // `allowMalformed`: a multipart body is bytes, and this test only ever
      // searches it for ASCII markers.
      body: utf8.decode(bytes, allowMalformed: true),
    );
    if (isRefresh) {
      refreshCalls.add(call);
      return onRefresh(call);
    }
    evidenceCalls.add(call);
    return onEvidence(call);
  }

  @override
  void close({bool force = false}) {}
}

/// Same in-memory fake pattern as
/// test/core/storage/secure_token_storage_test.dart.
class _FakeSecureStorage implements FlutterSecureStorage {
  _FakeSecureStorage([Map<String, String>? seed])
      : _values = {...?seed};

  final Map<String, String> _values;

  @override
  Future<String?> read({
    required String key,
    IOSOptions? iOptions,
    AndroidOptions? aOptions,
    LinuxOptions? lOptions,
    WebOptions? webOptions,
    MacOsOptions? mOptions,
    WindowsOptions? wOptions,
  }) async =>
      _values[key];

  @override
  Future<void> write({
    required String key,
    required String? value,
    IOSOptions? iOptions,
    AndroidOptions? aOptions,
    LinuxOptions? lOptions,
    WebOptions? webOptions,
    MacOsOptions? mOptions,
    WindowsOptions? wOptions,
  }) async {
    if (value == null) {
      _values.remove(key);
    } else {
      _values[key] = value;
    }
  }

  @override
  Future<void> delete({
    required String key,
    IOSOptions? iOptions,
    AndroidOptions? aOptions,
    LinuxOptions? lOptions,
    WebOptions? webOptions,
    MacOsOptions? mOptions,
    WindowsOptions? wOptions,
  }) async {
    _values.remove(key);
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

/// A Keystore that is broken, which is a real Android state and not a
/// hypothetical one: a restored backup, an OS upgrade that rotated the master
/// key, or a device whose secure hardware is failing.
class _ThrowingSecureStorage implements FlutterSecureStorage {
  @override
  Future<String?> read({
    required String key,
    IOSOptions? iOptions,
    AndroidOptions? aOptions,
    LinuxOptions? lOptions,
    WebOptions? webOptions,
    MacOsOptions? mOptions,
    WindowsOptions? wOptions,
  }) async =>
      throw StateError('keystore unavailable');

  @override
  Future<void> write({
    required String key,
    required String? value,
    IOSOptions? iOptions,
    AndroidOptions? aOptions,
    LinuxOptions? lOptions,
    WebOptions? webOptions,
    MacOsOptions? mOptions,
    WindowsOptions? wOptions,
  }) async =>
      throw StateError('keystore unavailable');

  @override
  Future<void> delete({
    required String key,
    IOSOptions? iOptions,
    AndroidOptions? aOptions,
    LinuxOptions? lOptions,
    WebOptions? webOptions,
    MacOsOptions? mOptions,
    WindowsOptions? wOptions,
  }) async =>
      throw StateError('keystore unavailable');

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}
