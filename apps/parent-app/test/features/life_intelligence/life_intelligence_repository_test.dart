// THE BOUNDARY THAT SANITISES, AND THE PROMISE THAT IT DOES NOT DELETE.
//
// EXECUTION STATUS: NEVER RUN. No Flutter or Dart SDK is reachable from the
// environment this was authored in (pub.dev, dl.google.com and
// storage.googleapis.com all answer 403 to CONNECT), so `flutter test` was
// never invoked. STATIC VERIFIED ONLY by `scripts/dart_preflight.py`, which
// executes nothing. First execution is on a GitHub runner.
//
// Replacing the transport's own sentence with a reviewed one is only
// defensible while the original still reaches somewhere an engineer can read
// it. These tests are what stops that second half from quietly rotting.

import 'package:flutter_test/flutter_test.dart';

import 'package:parent_app/core/errors/api_failure.dart';
import 'package:parent_app/core/network/api_exception.dart';
import 'package:parent_app/core/observability/failure_logger.dart';
import 'package:parent_app/features/life_intelligence/data/life_intelligence_repository.dart';

import '../../support/life_intelligence_test_harness.dart';

void main() {
  group('LifeIntelligenceRepository', () {
    test('returns the API payload untouched on the happy path', () async {
      final repository = LifeIntelligenceRepository(
        FakeLifeIntelligenceApi(onGetHabits: () async => [
              {'id': 'h1', 'title': 'قراءة عشر صفحات'},
            ]),
        logger: RecordingFailureLogger(),
      );

      final habits = await repository.getHabits('child_1');

      expect(habits, hasLength(1));
      expect((habits.first as Map)['title'], 'قراءة عشر صفحات');
    });

    test('converts an ApiException into an ApiFailure carrying the server '
        'Arabic', () async {
      final repository = LifeIntelligenceRepository(
        FakeLifeIntelligenceApi(
          onGetHabits: () => Future<List<dynamic>>.error(ApiException(
            'Refused.',
            messageAr: 'تعذّر تحميل العادات الآن.',
            code: 'HABITS_UNAVAILABLE',
            statusCode: 503,
            requestId: 'req_habits_1',
          )),
        ),
        logger: RecordingFailureLogger(),
      );

      // `on ApiFailure` and not `catch (e)`: the type is part of the
      // contract, because every caller above this line branches on it.
      ApiFailure? caught;
      try {
        await repository.getHabits('child_1');
      } on ApiFailure catch (failure) {
        caught = failure;
      }

      expect(caught, isNotNull);
      expect(caught!.display, 'تعذّر تحميل العادات الآن.');
      expect(caught.requestId, 'req_habits_1');
    });

    test('a proxy 502 reaches the caller as reviewed Arabic — never Dio\'s '
        'own sentence, never the status code', () async {
      final repository = LifeIntelligenceRepository(
        FakeLifeIntelligenceApi(
          onGetHabits: () => Future<List<dynamic>>.error(ApiException(
            'The request returned an invalid status code of 502.',
            statusCode: 502,
          )),
        ),
        logger: RecordingFailureLogger(),
      );

      ApiFailure? caught;
      try {
        await repository.getHabits('child_1');
      } on ApiFailure catch (failure) {
        caught = failure;
      }

      expect(caught, isNotNull);
      expect(caught!.display, ApiFailure.unexpected.messageAr);
      expect(caught.display, isNot(contains('502')));
    });

    test('HANDS THE ORIGINAL ERROR AND ITS STACK TO THE LOGGER BEFORE '
        'converting', () async {
      final logger = RecordingFailureLogger();
      final original = ApiException(
        'The request returned an invalid status code of 502.',
        statusCode: 502,
        requestId: 'req_proxy_7',
      );
      final repository = LifeIntelligenceRepository(
        FakeLifeIntelligenceApi(
          onGetHabits: () => Future<List<dynamic>>.error(original),
        ),
        logger: logger,
      );

      try {
        await repository.getHabits('child_1');
      } on ApiFailure {
        // Expected — the assertions are about what was logged on the way.
      }

      expect(logger.records, hasLength(1));
      final record = logger.records.single;
      // The ORIGINAL object, not the sanitised view of it.
      expect(identical(record.error, original), isTrue);
      expect(record.stackTrace, isNotNull);
      // Named, so a log line says WHICH call failed.
      expect(record.operation, 'getHabits');
      // And the diagnostic really is on the failure, not only in the log.
      expect(record.failure.diagnostic, contains('invalid status code of 502'));
      expect(record.failure.logLine, contains('req_proxy_7'));
    });

    test('a non-ApiException — a shape change inside a cast — is logged and '
        'converted too, rather than escaping as itself', () async {
      final logger = RecordingFailureLogger();
      final repository = LifeIntelligenceRepository(
        FakeLifeIntelligenceApi(
          onGetHabits: () => Future<List<dynamic>>.error(
            const FormatException('Unexpected end of input'),
          ),
        ),
        logger: logger,
      );

      ApiFailure? caught;
      try {
        await repository.getHabits('child_1');
      } on ApiFailure catch (failure) {
        caught = failure;
      }

      expect(caught, isNotNull);
      expect(caught!.isUnexpected, isTrue);
      expect(caught.display, isNot(contains('FormatException')));
      expect(logger.records.single.failure.diagnostic, contains('Unexpected end of input'));
    });

    test('a void action is guarded on the same path as a read', () async {
      final logger = RecordingFailureLogger();
      final repository = LifeIntelligenceRepository(
        FakeLifeIntelligenceApi(
          onCompleteHabit: () => Future<void>.error(ApiException(
            'Already completed today.',
            messageAr: 'سُجّلت هذه العادة اليوم بالفعل.',
            code: 'ALREADY_COMPLETED',
            statusCode: 409,
          )),
        ),
        logger: logger,
      );

      ApiFailure? caught;
      try {
        await repository.completeHabit('child_1', 'habit_1');
      } on ApiFailure catch (failure) {
        caught = failure;
      }

      expect(caught, isNotNull);
      expect(caught!.display, 'سُجّلت هذه العادة اليوم بالفعل.');
      expect(logger.records.single.operation, 'completeHabit');
    });
  });
}
