// A CODE IS SPENT ONCE, SO THE TWO FAILURES ARE NOT INTERCHANGEABLE.
//
// The point of these tests is not "the screen shows an error" — it is that
// "this code is no good" and "the code is untouched, try it again" stay
// distinguishable after the raw exception text was taken away. A single
// friendlier sentence covering both would be a clearer message that leads a
// parent to the wrong action.
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
import 'package:parent_app/features/billing/data/campaign_repository.dart';
import 'package:parent_app/features/billing/presentation/redeem_code_screen.dart';

import '../../support/last_screens_test_harness.dart';

Future<void> _submitCode(WidgetTester tester, String code) async {
  await tester.enterText(find.byType(TextField), code);
  await tester.pump();
  await tester.tap(find.byType(FilledButton));
  await tester.pump();
  await tester.pump();
}

void main() {
  group('CampaignRepository', () {
    test("carries the server's own sentence through, numbers and all",
        () async {
      final repository = CampaignRepository(
        FakeCampaignApi(onRedeemCode: () async => {
              'campaignType': 'TRIAL_EXTENSION',
              'message': 'Your trial has been extended by 14 day(s), now ending 2026-09-01.',
            }),
        logger: RecordingFailureLogger(),
      );

      final result = await repository.redeemCode('ABNY-2026');

      expect(result.campaignType, 'TRIAL_EXTENSION');
      expect(result.message, contains('14 day(s)'));
    });

    test('a body with no message is not an error — it is a success the server '
        'chose not to describe', () async {
      final repository = CampaignRepository(
        FakeCampaignApi(onRedeemCode: () async => {'campaignType': 'COUPON'}),
        logger: RecordingFailureLogger(),
      );

      final result = await repository.redeemCode('ABNY-2026');

      expect(result.message, isNull);
    });

    test('a 404 arrives as an ApiFailure the screen can classify, with the '
        'original preserved for the log', () async {
      final logger = RecordingFailureLogger();
      final repository = CampaignRepository(
        FakeCampaignApi(
          onRedeemCode: () => Future<Map<String, dynamic>>.error(ApiException(
            'This code is invalid, expired, or no longer active.',
            messageAr: 'لم نجد ما تبحث عنه.',
            code: 'NOT_FOUND',
            statusCode: 404,
            requestId: 'req_redeem_9',
          )),
        ),
        logger: logger,
      );

      ApiFailure? caught;
      try {
        await repository.redeemCode('ABNY-2026');
      } on ApiFailure catch (failure) {
        caught = failure;
      }

      expect(caught, isNotNull);
      expect(caught!.isServerRefusal, isTrue);
      expect(caught.display, 'لم نجد ما تبحث عنه.');
      expect(logger.records.single.operation, 'redeemCode');
      expect(logger.records.single.failure.requestId, 'req_redeem_9');
    });
  });

  group('RedeemCodeScreen', () {
    testWidgets('a rejected code says so — the parent should stop retyping it',
        (tester) async {
      await pumpParentScreen(
        tester,
        const RedeemCodeScreen(),
        overrides: [
          campaignRepositoryProvider.overrideWithValue(
            FakeCampaignRepository(
              onRedeemCode: () => failingWith<CampaignRedemption>(
                refusalFailure(
                  statusCode: 404,
                  code: 'NOT_FOUND',
                  messageAr: 'لم نجد ما تبحث عنه.',
                ),
              ),
            ),
          ),
        ],
      );

      await _submitCode(tester, 'ABNY-2026');

      expect(find.text(ar('redeemCode.rejectedTitle')), findsOneWidget);
      expect(find.text(ar('redeemCode.notAppliedTitle')), findsNothing);
    });

    testWidgets('A 502 IS NOT A VERDICT ON THE CODE. It says the code has not '
        'been used, and never shows the transport sentence', (tester) async {
      await pumpParentScreen(
        tester,
        const RedeemCodeScreen(),
        overrides: [
          campaignRepositoryProvider.overrideWithValue(
            FakeCampaignRepository(
              onRedeemCode: () => failingWith<CampaignRedemption>(proxyFailure()),
            ),
          ),
        ],
      );

      await _submitCode(tester, 'ABNY-2026');

      expect(find.text(ar('redeemCode.notAppliedTitle')), findsOneWidget);
      expect(find.text(ar('redeemCode.rejectedTitle')), findsNothing);
      expect(find.textContaining('502'), findsNothing);
      expect(find.textContaining('invalid status code'), findsNothing);
    });

    testWidgets('THE THROTTLE IS NOT A VERDICT ON THE CODE EITHER — 5/min on '
        'this endpoint fires on a parent\'s second try with a valid code',
        (tester) async {
      await pumpParentScreen(
        tester,
        const RedeemCodeScreen(),
        overrides: [
          campaignRepositoryProvider.overrideWithValue(
            FakeCampaignRepository(
              onRedeemCode: () => failingWith<CampaignRedemption>(rateLimitFailure()),
            ),
          ),
        ],
      );

      await _submitCode(tester, 'ABNY-2026');

      expect(find.text(ar('redeemCode.notAppliedTitle')), findsOneWidget);
      expect(find.text(ar('redeemCode.rejectedTitle')), findsNothing);
    });

    testWidgets("success renders the server's own sentence verbatim",
        (tester) async {
      await pumpParentScreen(
        tester,
        const RedeemCodeScreen(),
        overrides: [
          campaignRepositoryProvider.overrideWithValue(
            FakeCampaignRepository(
              onRedeemCode: () async => const CampaignRedemption(
                campaignType: 'TRIAL_EXTENSION',
                message: 'تم تمديد فترتك التجريبية 14 يومًا.',
              ),
            ),
          ),
        ],
      );

      await _submitCode(tester, 'ABNY-2026');

      expect(find.text('تم تمديد فترتك التجريبية 14 يومًا.'), findsOneWidget);
      expect(find.text(ar('redeemCode.successFallback')), findsNothing);
    });

    testWidgets('a success the server did not describe still reads as a '
        'success, in Arabic — never the old English "Success!"', (tester) async {
      await pumpParentScreen(
        tester,
        const RedeemCodeScreen(),
        overrides: [
          campaignRepositoryProvider.overrideWithValue(
            FakeCampaignRepository(
              onRedeemCode: () async => const CampaignRedemption(campaignType: 'COUPON'),
            ),
          ),
        ],
      );

      await _submitCode(tester, 'ABNY-2026');

      expect(find.text(ar('redeemCode.successFallback')), findsOneWidget);
      expect(find.text('Success!'), findsNothing);
    });
  });
}
