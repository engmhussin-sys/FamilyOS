// THE CONVERSION THAT DECIDES WHAT A PARENT READS.
//
// EXECUTION STATUS: NEVER RUN. No Flutter or Dart SDK is reachable from the
// environment this was authored in (pub.dev, dl.google.com and
// storage.googleapis.com all answer 403 to CONNECT), so `flutter test` was
// never invoked. STATIC VERIFIED ONLY by `scripts/dart_preflight.py`, which
// checks arity, named parameters, member references and import scope and
// executes nothing. First execution is on a GitHub runner.
//
// These are pure Dart — no widgets, no pumping. They pin the two properties
// the whole error pass rests on:
//   1. the server's Arabic reaches `display` untouched;
//   2. text the server did NOT author never does, and is not lost either.

import 'package:flutter_test/flutter_test.dart';

import 'package:parent_app/core/errors/api_failure.dart';
import 'package:parent_app/core/network/api_exception.dart';

void main() {
  group('ApiFailure.from — a B3 envelope', () {
    test('carries the server Arabic through verbatim', () {
      final failure = ApiFailure.from(ApiException(
        'This action has already been done today.',
        messageAr: 'أكملت هذا البرنامج مرة اليوم — نراك غدًا!',
        code: 'MAX_PER_DAY_REACHED',
        statusCode: 409,
        requestId: 'req_abc123',
      ));

      expect(failure.display, 'أكملت هذا البرنامج مرة اليوم — نراك غدًا!');
      expect(failure.displayFor(arabic: true), 'أكملت هذا البرنامج مرة اليوم — نراك غدًا!');
      // Not rewritten, not prefixed, not run through `t()`. The sentence the
      // backend reviewed is the sentence on screen.
      expect(failure.displayFor(arabic: false), 'This action has already been done today.');
      expect(failure.isUnexpected, isFalse);
    });

    test('keeps the fields support needs to find the backend log row', () {
      final failure = ApiFailure.from(ApiException(
        'Refused.',
        messageAr: 'مرفوض.',
        code: 'ATTEMPT_ALREADY_OPEN',
        statusCode: 409,
        correlationId: 'corr_1',
      ));

      expect(failure.code, 'ATTEMPT_ALREADY_OPEN');
      expect(failure.statusCode, 409);
      // `requestId` falls back to `correlationId` — B3 sends the same value
      // under both names and a support ticket quotes whichever arrived.
      expect(failure.requestId, 'corr_1');
    });

    test('substitutes reviewed Arabic when the envelope carried none, rather '
        'than showing an Arabic-locale parent an English sentence', () {
      final failure = ApiFailure.from(ApiException(
        'Forbidden resource.',
        code: 'FORBIDDEN',
        statusCode: 403,
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
        statusCode: 502,
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
        statusCode: 502,
        requestId: 'req_proxy_9',
      ));

      // THE POINT OF `diagnostic`: what a parent must not read is exactly
      // what an engineer must be able to.
      expect(failure.diagnostic, 'The request returned an invalid status code of 502.');
      expect(failure.statusCode, 502);
      expect(failure.requestId, 'req_proxy_9');
      expect(failure.logLine, contains('502'));
      expect(failure.logLine, contains('req_proxy_9'));
      expect(failure.logLine, contains('invalid status code'));
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

  group('ApiFailure.from — the transport classifications', () {
    test('a dropped socket keeps its own reviewed Arabic and stays offline', () {
      final failure = ApiFailure.from(ApiException(
        'Connection closed before full header was received',
        code: 'CLIENT_OFFLINE',
      ));

      expect(failure.isOffline, isTrue);
      expect(failure.display, ApiFailure.offline.messageAr);
      expect(failure.display, isNot(contains('Connection closed')));
    });

    test('a timeout keeps its own reviewed Arabic', () {
      final failure = ApiFailure.from(ApiException('irrelevant', code: 'CLIENT_TIMEOUT'));

      expect(failure.isTimeout, isTrue);
      expect(failure.display, ApiFailure.timeout.messageAr);
    });

    test('converting an ApiFailure is the identity, so a repository that '
        'guards a guard cannot double-sanitise', () {
      const original = ApiFailure(
        message: 'Refused.',
        messageAr: 'مرفوض.',
        code: 'SOME_CODE',
        requestId: 'req_1',
      );

      final again = ApiFailure.from(original);

      expect(identical(again, original), isTrue);
      expect(again.display, 'مرفوض.');
    });
  });

  group('field errors', () {
    test('survive the conversion so a create form can point at the field', () {
      final failure = ApiFailure.from(ApiException(
        'Validation failed.',
        messageAr: 'تعذّر حفظ الهدف.',
        code: 'TARGET_SPEC_INVALID',
        statusCode: 400,
        details: const {
          'errors': [
            {'field': 'fromAyah', 'code': 'OUT_OF_RANGE', 'messageAr': 'رقم الآية خارج النطاق.'},
          ],
        },
      ));

      expect(failure.fieldErrors, hasLength(1));
      expect(failure.fieldErrors.first.field, 'fromAyah');
      expect(failure.fieldErrors.first.display, 'رقم الآية خارج النطاق.');
    });
  });
}
