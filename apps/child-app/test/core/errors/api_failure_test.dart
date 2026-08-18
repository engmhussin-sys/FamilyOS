// THE CONVERSION THAT DECIDES WHAT A CHILD READS.
//
// EXECUTION STATUS: NEVER RUN. No Flutter or Dart SDK is reachable from the
// environment this was authored in (pub.dev, dl.google.com and
// storage.googleapis.com all answer 403 to CONNECT), so `flutter test` was
// never invoked. STATIC VERIFIED ONLY by `scripts/dart_preflight.py`, which
// checks arity, named parameters, member references and import scope and
// executes nothing. First execution is on a GitHub runner.
//
// These are pure Dart — no widgets, no pumping. They pin the property the
// child-side error pass rests on, and which the Parent App already had:
// the server's Arabic reaches `display` untouched, and text the server did
// NOT author never does — while still not being lost.
//
// WHY THIS MATTERS MORE ON THIS SIDE. `KidErrorState` renders
// `failure.displayFor(arabic:)` directly. Before this pass, a proxy 502
// arrived with `messageAr == null`, so `display` fell through to Dio's own
// «The request returned an invalid status code of 502» — an English
// operational string carrying an HTTP status code, shown to a child.

import 'package:flutter_test/flutter_test.dart';

import 'package:child_app/core/errors/api_failure.dart';
import 'package:child_app/core/network/api_exception.dart';

void main() {
  group('ApiFailure.from — a B3 envelope', () {
    test('carries the server Arabic through verbatim', () {
      final failure = ApiFailure.from(ApiException(
        'This program was already completed today.',
        409,
        code: 'MAX_PER_DAY_REACHED',
        messageAr: 'أكملت هذا البرنامج مرة اليوم — نراك غدًا!',
        requestId: 'req_abc123',
      ));

      expect(failure.display, 'أكملت هذا البرنامج مرة اليوم — نراك غدًا!');
      expect(failure.displayFor(arabic: true), 'أكملت هذا البرنامج مرة اليوم — نراك غدًا!');
      // Not rewritten, not prefixed, not run through `t()`. The sentence F4
      // wrote is the sentence on screen.
      expect(failure.displayFor(arabic: false), 'This program was already completed today.');
      expect(failure.isUnexpected, isFalse);
      // A designed "no", not a breakage — sunshine, not coral.
      expect(failure.isNotNow, isTrue);
    });

    test('substitutes reviewed Arabic when the envelope carried none, rather '
        'than showing a child an English sentence', () {
      final failure = ApiFailure.from(ApiException(
        'Forbidden resource.',
        403,
        code: 'FORBIDDEN',
      ));

      expect(failure.displayFor(arabic: true), ApiFailure.unexpected.messageAr);
      // The English is still the server's own, for an `en` session.
      expect(failure.displayFor(arabic: false), 'Forbidden resource.');
      expect(failure.statusCode, 403);
    });
  });

  group('ApiFailure.from — nothing the server worded', () {
    test('a proxy 502 renders reviewed Arabic, never Dio\'s sentence and '
        'never the status code', () {
      final failure = ApiFailure.from(ApiException(
        'The request returned an invalid status code of 502.',
        502,
      ));

      expect(failure.isUnexpected, isTrue);
      expect(failure.displayFor(arabic: true), ApiFailure.unexpected.messageAr);
      expect(failure.displayFor(arabic: false), ApiFailure.unexpected.message);
      expect(failure.display, isNot(contains('502')));
      expect(failure.display, isNot(contains('invalid status code')));
      expect(failure.displayEn, isNot(contains('502')));
    });

    test('but does not throw the real error away', () {
      final failure = ApiFailure.from(ApiException(
        'The request returned an invalid status code of 502.',
        502,
        requestId: 'req_proxy_9',
      ));

      // THE POINT OF `diagnostic`: what a child must not read is exactly what
      // an engineer must be able to.
      expect(failure.diagnostic, 'The request returned an invalid status code of 502.');
      expect(failure.statusCode, 502);
      expect(failure.requestId, 'req_proxy_9');
    });

    test('an error that is not an ApiException at all — a shape change '
        'inside a cast — is handled the same way', () {
      final failure = ApiFailure.from(const FormatException('Unexpected end of input'));

      expect(failure.isUnexpected, isTrue);
      expect(failure.display, ApiFailure.unexpected.messageAr);
      expect(failure.display, isNot(contains('FormatException')));
      expect(failure.diagnostic, contains('Unexpected end of input'));
    });
  });

  group('ApiFailure.from — the transport classifications keep their own words', () {
    test('a dropped socket keeps ApiClient\'s reviewed Arabic', () {
      final failure = ApiFailure.from(ApiException(
        'No internet connection.',
        0,
        code: 'CLIENT_OFFLINE',
        messageAr: 'مفيش إنترنت دلوقتي. هنكمّل أول ما يرجع.',
      ));

      expect(failure.isOffline, isTrue);
      expect(failure.isUnexpected, isFalse);
      expect(failure.display, 'مفيش إنترنت دلوقتي. هنكمّل أول ما يرجع.');
    });

    test('a timeout keeps ApiClient\'s reviewed Arabic', () {
      final failure = ApiFailure.from(ApiException(
        'The request took too long.',
        0,
        code: 'CLIENT_TIMEOUT',
        messageAr: 'الاتصال بطيء شوية. جرّب تاني بعد لحظة.',
      ));

      expect(failure.isTimeout, isTrue);
      expect(failure.isUnexpected, isFalse);
      expect(failure.display, 'الاتصال بطيء شوية. جرّب تاني بعد لحظة.');
    });

    test('converting an ApiFailure is the identity, so a repository that '
        'guards a guard cannot double-sanitise', () {
      const original = ApiFailure(
        message: 'Refused.',
        messageAr: 'مرفوض.',
        code: 'SOME_CODE',
        requestId: 'req_1',
      );

      expect(ApiFailure.from(original).display, 'مرفوض.');
      expect(ApiFailure.from(original).code, 'SOME_CODE');
      expect(ApiFailure.from(original).requestId, 'req_1');
    });
  });
}
