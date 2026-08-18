// THE MOST DESTRUCTIVE SCREEN IN THE APP, AND THE THREE THINGS IT MUST NEVER
// GET WRONG: show raw exception text, read as a success when it failed, or
// state as a fact something it does not know.
//
// EXECUTION STATUS: NEVER RUN. No Flutter or Dart SDK is reachable from the
// environment this was authored in (pub.dev, dl.google.com and
// storage.googleapis.com all answer 403 to CONNECT), so `flutter test` was
// never invoked. STATIC VERIFIED ONLY by `scripts/dart_preflight.py`, which
// executes nothing. First execution is on a GitHub runner.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:parent_app/core/design_system/design_system.dart';
import 'package:parent_app/core/di/providers.dart';
import 'package:parent_app/core/errors/api_failure.dart';
import 'package:parent_app/core/network/api_exception.dart';
import 'package:parent_app/core/observability/failure_logger.dart';
import 'package:parent_app/features/settings/data/account_repository.dart';
import 'package:parent_app/features/settings/presentation/delete_account_screen.dart';

import '../../support/last_screens_test_harness.dart';

/// Fills the form far enough that the Delete button is enabled, then presses
/// it. Mirrors what a parent actually has to do: tick the box, type the
/// password, press the button.
Future<void> _submitForm(WidgetTester tester) async {
  await tester.tap(find.byType(CheckboxListTile));
  await tester.pump();
  await tester.enterText(find.byType(TextField), 'hunter2');
  await tester.pump();
  await tester.tap(find.byType(FilledButton));
  // Two frames: one to run `_submit` up to its first await, one to rebuild
  // with whatever it set. NOT pumpAndSettle — the submitting state holds an
  // indeterminate CircularProgressIndicator whose animation never settles.
  await tester.pump();
  await tester.pump();
}

void main() {
  group('AccountRepository', () {
    test('passes the typed password straight through on the happy path',
        () async {
      final api = FakeAccountApi(onDeleteAccount: () async {});
      final repository = AccountRepository(api, logger: RecordingFailureLogger());

      await repository.deleteAccount('hunter2');

      expect(api.lastPassword, 'hunter2');
    });

    test("a proxy 502 reaches the caller as reviewed Arabic — never Dio's own "
        'sentence, never the status code', () async {
      final repository = AccountRepository(
        FakeAccountApi(
          onDeleteAccount: () => Future<void>.error(ApiException(
            'The request returned an invalid status code of 502.',
            statusCode: 502,
          )),
        ),
        logger: RecordingFailureLogger(),
      );

      ApiFailure? caught;
      try {
        await repository.deleteAccount('hunter2');
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
        requestId: 'req_delete_7',
      );
      final repository = AccountRepository(
        FakeAccountApi(onDeleteAccount: () => Future<void>.error(original)),
        logger: logger,
      );

      try {
        await repository.deleteAccount('hunter2');
      } on ApiFailure {
        // Expected — the assertions are about what was logged on the way.
      }

      expect(logger.records, hasLength(1));
      final record = logger.records.single;
      expect(identical(record.error, original), isTrue);
      expect(record.stackTrace, isNotNull);
      expect(record.operation, 'deleteAccount');
      expect(record.failure.diagnostic, contains('invalid status code of 502'));
      expect(record.failure.logLine, contains('req_delete_7'));
    });
  });

  group('DeleteAccountScreen', () {
    testWidgets('a refusal states plainly that the account was NOT deleted, '
        'and shows the server sentence rather than the raw error',
        (tester) async {
      final failure = refusalFailure(
        statusCode: 401,
        code: 'UNAUTHENTICATED',
        messageAr: 'كلمة السر غير صحيحة.',
      );
      await pumpParentScreen(
        tester,
        const DeleteAccountScreen(),
        overrides: [
          accountRepositoryProvider.overrideWithValue(
            FakeAccountRepository(onDeleteAccount: () => failingWith<void>(failure)),
          ),
        ],
      );

      await _submitForm(tester);

      expect(find.text(ar('deleteAccount.errorRefusedTitle')), findsOneWidget);
      expect(find.text('كلمة السر غير صحيحة.'), findsOneWidget);
      // The screen did not navigate: it is still the delete form.
      expect(find.text(ar('deleteAccount.warningTitle')), findsOneWidget);
    });

    testWidgets('A 502 NEVER PUTS THE TRANSPORT SENTENCE ON SCREEN, and does '
        'not claim the account is intact either', (tester) async {
      final failure = proxyFailure();
      await pumpParentScreen(
        tester,
        const DeleteAccountScreen(),
        overrides: [
          accountRepositoryProvider.overrideWithValue(
            FakeAccountRepository(onDeleteAccount: () => failingWith<void>(failure)),
          ),
        ],
      );

      await _submitForm(tester);

      // The unconfirmed title, NOT «لم يتم حذف حسابك» — the app never heard
      // back, so it cannot say what did or did not happen.
      expect(find.text(ar('deleteAccount.errorUnconfirmedTitle')), findsOneWidget);
      expect(find.text(ar('deleteAccount.errorRefusedTitle')), findsNothing);
      // And the thing this whole pass exists to stop.
      expect(find.textContaining('502'), findsNothing);
      expect(find.textContaining('invalid status code'), findsNothing);
    });

    testWidgets('offline is an unconfirmed outcome too, and renders the '
        "client's reviewed Arabic", (tester) async {
      await pumpParentScreen(
        tester,
        const DeleteAccountScreen(),
        overrides: [
          accountRepositoryProvider.overrideWithValue(
            FakeAccountRepository(
              onDeleteAccount: () => failingWith<void>(ApiFailure.offline),
            ),
          ),
        ],
      );

      await _submitForm(tester);

      expect(find.text(ar('deleteAccount.errorUnconfirmedTitle')), findsOneWidget);
      expect(find.text(ApiFailure.offline.messageAr!), findsOneWidget);
    });

    testWidgets('dismissing the error clears it without re-firing the delete',
        (tester) async {
      final repository = FakeAccountRepository(
        onDeleteAccount: () => failingWith<void>(refusalFailure()),
      );
      await pumpParentScreen(
        tester,
        const DeleteAccountScreen(),
        overrides: [accountRepositoryProvider.overrideWithValue(repository)],
      );

      await _submitForm(tester);
      expect(repository.deleteCalls, 1);
      expect(find.byType(DsErrorState), findsOneWidget);

      // The DsErrorState's action is labelled "dismiss", not "retry" — a
      // permanent deletion is not something an error state should re-fire.
      await tester.tap(find.text(ar('common.dismiss')));
      await tester.pump();

      expect(find.byType(DsErrorState), findsNothing);
      expect(repository.deleteCalls, 1);
    });
  });
}
