// THE SCREEN A PARENT REACHES WHEN SOMETHING IS ALREADY WRONG.
//
// It answered its own failure with the transport's English sentence, which
// is the worst possible place for one: the parent is already stuck, and the
// app hands them a second thing they cannot act on. These pin that the
// server's Arabic reaches the screen, that the raw text does not, and that
// the success state is still unmistakably a success.
//
// EXECUTION STATUS: NEVER RUN. No Flutter or Dart SDK is reachable from the
// environment this was authored in (pub.dev, dl.google.com and
// storage.googleapis.com all answer 403 to CONNECT), so `flutter test` was
// never invoked. STATIC VERIFIED ONLY by `scripts/dart_preflight.py`, which
// executes nothing. First execution is on a GitHub runner.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:parent_app/core/di/providers.dart';
import 'package:parent_app/core/errors/api_failure.dart';
import 'package:parent_app/core/network/api_exception.dart';
import 'package:parent_app/core/observability/failure_logger.dart';
import 'package:parent_app/features/support/data/support_repository.dart';
import 'package:parent_app/features/support/presentation/contact_support_screen.dart';

import '../../support/last_screens_test_harness.dart';

Future<void> _send(WidgetTester tester) async {
  await tester.tap(find.byType(FilledButton));
  await tester.pump();
  await tester.pump();
}

void main() {
  group('SupportRepository', () {
    test('logs the original with its stack, then throws the sanitised view',
        () async {
      final logger = RecordingFailureLogger();
      final original = ApiException(
        'The request returned an invalid status code of 502.',
        statusCode: 502,
        requestId: 'req_support_3',
      );
      final repository = SupportRepository(
        FakeSupportApi(onSubmitRequest: () => Future<void>.error(original)),
        logger: logger,
      );

      ApiFailure? caught;
      try {
        await repository.submitRequest(
          email: 'parent@example.com',
          subject: 'Pairing',
          message: 'The code does not work.',
        );
      } on ApiFailure catch (failure) {
        caught = failure;
      }

      expect(caught, isNotNull);
      expect(caught!.display, ApiFailure.unexpected.messageAr);
      expect(identical(logger.records.single.error, original), isTrue);
      expect(logger.records.single.operation, 'submitSupportRequest');
      // THE VALUE SUPPORT WOULD OTHERWISE HAVE HAD TO ASK THIS PARENT FOR.
      expect(logger.records.single.failure.requestId, 'req_support_3');
    });
  });

  group('ContactSupportScreen', () {
    testWidgets("a failure names the outcome and shows the server's Arabic, "
        'never the raw exception', (tester) async {
      await pumpParentScreen(
        tester,
        const ContactSupportScreen(),
        overrides: [
          supportRepositoryProvider.overrideWithValue(
            FakeSupportRepository(
              onSubmitRequest: () => failingWith<void>(
                refusalFailure(
                  statusCode: 422,
                  code: 'UNPROCESSABLE_ENTITY',
                  messageAr: 'فهمنا طلبك، لكن تعذّر تنفيذه بهذه البيانات.',
                ),
              ),
            ),
          ),
        ],
      );

      await _send(tester);

      expect(find.text(ar('support.sendFailedTitle')), findsOneWidget);
      expect(find.text('فهمنا طلبك، لكن تعذّر تنفيذه بهذه البيانات.'), findsOneWidget);
      // Still on the form, not on the "Message Sent!" state.
      expect(find.text(ar('support.sentTitle')), findsNothing);
    });

    testWidgets('a 502 never puts the transport sentence in front of a parent',
        (tester) async {
      await pumpParentScreen(
        tester,
        const ContactSupportScreen(),
        overrides: [
          supportRepositoryProvider.overrideWithValue(
            FakeSupportRepository(
              onSubmitRequest: () => failingWith<void>(proxyFailure()),
            ),
          ),
        ],
      );

      await _send(tester);

      expect(find.textContaining('502'), findsNothing);
      expect(find.textContaining('invalid status code'), findsNothing);
      expect(find.text(ApiFailure.unexpected.messageAr!), findsOneWidget);
    });

    testWidgets('a successful send still reaches the sent state', (tester) async {
      await pumpParentScreen(
        tester,
        const ContactSupportScreen(),
        overrides: [
          supportRepositoryProvider.overrideWithValue(
            FakeSupportRepository(onSubmitRequest: () async {}),
          ),
        ],
      );

      await _send(tester);

      expect(find.text(ar('support.sentTitle')), findsOneWidget);
      expect(find.text(ar('support.sendFailedTitle')), findsNothing);
    });
  });
}
