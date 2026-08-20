// THE CHILD'S HTTP CLIENT HAS TIMEOUTS, AND THE PARENT'S HAS THE SAME ONES.
//
// This client shipped with `BaseOptions(baseUrl: …)` and nothing else. Dio's
// default is «wait forever» on all three phases, so a half-open socket — a
// phone carried out of Wi-Fi range mid-upload, a middlebox that stops
// answering without ever closing — produced no exception at all. Nothing
// failed; the request simply never ended.
//
// The evidence upload is the worst place for it: `EvidenceController` sits in
// `EvidencePhase.uploading`, the card's spinner never stops, and
// `clearEvidence()` refuses to act while `isUploading` is true. A child on a
// frozen screen with no error and no way out — and `_toApiException` already
// had reviewed Egyptian Arabic for `CLIENT_TIMEOUT` that nothing could reach.
//
// The parent app had the fix and this app did not. These assertions read the
// numbers rather than the sockets, so they fail if a timeout is dropped, and
// the twin file in `apps/parent-app` asserts the same three values — the two
// apps are supposed to give up at the same point.
//
// EXECUTION STATUS: NEVER RUN. There is no Flutter SDK and no Dart SDK in the
// authoring environment, and pub.dev is unreachable, so this file has never
// been executed. It is STATIC VERIFIED by `scripts/dart_preflight.py` and
// `scripts/verify_dart_imports.py` only.

import 'package:flutter_test/flutter_test.dart';

import 'package:child_app/core/network/api_client.dart';

void main() {
  group('ApiClient.defaultOptions', () {
    test('sets a connect timeout — a dead host must fail, not hang', () {
      expect(ApiClient.defaultOptions().connectTimeout,
          const Duration(seconds: 15));
    });

    test('sets a receive timeout — a silent server must fail, not hang', () {
      expect(ApiClient.defaultOptions().receiveTimeout,
          const Duration(seconds: 20));
    });

    test('sets a send timeout — the 15 MiB evidence upload is the request '
        'that can stall mid-body', () {
      expect(
          ApiClient.defaultOptions().sendTimeout, const Duration(seconds: 30));
    });

    test('none of the three is left unset', () {
      final options = ApiClient.defaultOptions();
      expect(options.connectTimeout, isNotNull);
      expect(options.receiveTimeout, isNotNull);
      expect(options.sendTimeout, isNotNull);
    });
  });
}
