// THE PARENT'S HTTP CLIENT HAS ALL THREE TIMEOUTS, AND THE CHILD'S HAS THE
// SAME ONES.
//
// This client already set connect and receive. It did NOT set `sendTimeout`,
// while `_unwrap` was written to translate one — so a request whose BODY
// stalled on a half-open socket waited forever and no code path could ever
// produce the sentence that was sitting there for it.
//
// The twin file in `apps/child-app` asserts the same three values. The two
// apps talk to the same backend and are supposed to give up at the same point;
// a number changed in one and not the other is the divergence these files
// exist to catch.
//
// EXECUTION STATUS: NEVER RUN. There is no Flutter SDK and no Dart SDK in the
// authoring environment, and pub.dev is unreachable, so this file has never
// been executed. It is STATIC VERIFIED by `scripts/dart_preflight.py` and
// `scripts/verify_dart_imports.py` only.

import 'package:flutter_test/flutter_test.dart';

import 'package:parent_app/core/network/api_client.dart';

void main() {
  group('ApiClient.defaultOptions', () {
    test('sets a connect timeout — a dead host must fail, not hang', () {
      expect(ApiClient.defaultOptions().connectTimeout,
          const Duration(seconds: 15));
    });

    test('sets a receive timeout that clears the backend AI provider\'s own '
        '20s ceiling', () {
      expect(ApiClient.defaultOptions().receiveTimeout,
          const Duration(seconds: 20));
    });

    test('sets the send timeout `_unwrap` was already written to translate',
        () {
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
