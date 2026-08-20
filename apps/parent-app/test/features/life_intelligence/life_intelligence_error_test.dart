// WHAT A PARENT ACTUALLY READS WHEN A LIFE INTELLIGENCE SCREEN FAILS.
//
// EXECUTION STATUS: NEVER RUN. No Flutter or Dart SDK is reachable from the
// environment these were authored in (pub.dev, dl.google.com and
// storage.googleapis.com all answer 403 to CONNECT), so `flutter test` was
// never invoked. STATIC VERIFIED ONLY by `scripts/dart_preflight.py`, which
// checks constructor arity, named parameters, member references and import
// scope, and executes nothing. First execution is on a GitHub runner.
//
// BEFORE THIS PASS every one of these ten screens did
// `catch (e) { _errorMessage = e.toString(); }` and then rendered a generic
// `common.error` on top, so the server's reviewed Arabic was discarded and
// the raw transport sentence sat in widget state one refactor away from a
// screen. These tests pin three things per shape of screen:
//
//   1. a `messageAr`-bearing failure renders the ARABIC, and not the
//      English that arrived in the same envelope;
//   2. a failure the server never worded — a proxy 502, a dropped socket —
//      still renders a sentence a human can act on, and never the raw text
//      or the status code;
//   3. the requestId is on screen for support, but is not the headline.
//
// Plus the two raw backend values these screens used to print.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:parent_app/core/design_system/design_system.dart';
import 'package:parent_app/core/errors/api_failure.dart';
import 'package:parent_app/core/localization/localization_engine.dart';
import 'package:parent_app/features/life_intelligence/presentation/coaching_screen.dart';
import 'package:parent_app/features/life_intelligence/presentation/digital_twin_screen.dart';
import 'package:parent_app/features/life_intelligence/presentation/habit_tracker_screen.dart';
import 'package:parent_app/features/life_intelligence/presentation/health_trend_screen.dart';
import 'package:parent_app/features/life_intelligence/presentation/pending_approvals_screen.dart';
import 'package:parent_app/features/life_intelligence/presentation/wellbeing_screen.dart';

import '../../support/life_intelligence_test_harness.dart';

void main() {
  // =========================================================================
  group('CoachingScreen — a list-shaped screen', () {
    testWidgets('renders the loading state while the repository is silent',
        (tester) async {
      await pumpLifeScreen(
        tester,
        const CoachingScreen(childId: 'child_1', childName: 'سلمى'),
        repository: FakeLifeIntelligenceRepository(
          onGetCoachingRecommendations: () => pending<List<dynamic>>(),
        ),
      );

      // UPDATED BY THE DESIGN PASS, DELIBERATELY.
      // Was: `expect(find.byType(CircularProgressIndicator), findsOneWidget);`
      // The assertion's INTENT is unchanged — a silent repository leaves
      // this screen in its LOADING state and not its error state. What
      // changed is what a loading state draws: this screen renders a list
      // of cards, a shape known before the data arrives, so it now draws a
      // skeleton of that shape instead of a bare spinner. The assertion is
      // strengthened rather than weakened: it pins BOTH that the skeleton
      // is there and that the spinner it replaced is gone.
      expect(find.byType(DsSkeletonList), findsOneWidget);
      expect(find.byType(CircularProgressIndicator), findsNothing);
      expect(find.byType(DsErrorState), findsNothing);
    });

    testWidgets('renders the SERVER\'S ARABIC — not the English that came in '
        'the same envelope, and not a generic client sentence', (tester) async {
      await pumpLifeScreen(
        tester,
        const CoachingScreen(childId: 'child_1', childName: 'سلمى'),
        repository: FakeLifeIntelligenceRepository(
          onGetCoachingRecommendations: () => failingWith<List<dynamic>>(envelopeFailure),
        ),
      );
      await tester.pump();

      expect(find.byType(DsErrorState), findsOneWidget);
      // The line this whole pass exists for.
      expect(find.text(envelopeFailure.messageAr!), findsOneWidget);
      expect(find.text(envelopeFailure.message), findsNothing);
      // Not rewritten into the client's own words either.
      expect(find.text(ApiFailure.unexpected.messageAr!), findsNothing);
      // And the chrome around it stays localised.
      expect(find.text(ar('common.error')), findsOneWidget);
      expect(find.text(ar('common.retry')), findsOneWidget);
    });

    testWidgets('an ENGLISH session gets the English half of the same '
        'envelope', (tester) async {
      await pumpLifeScreen(
        tester,
        const CoachingScreen(childId: 'child_1', childName: 'Salma'),
        repository: FakeLifeIntelligenceRepository(
          onGetCoachingRecommendations: () => failingWith<List<dynamic>>(envelopeFailure),
        ),
        locale: AppLocale.en,
      );
      await tester.pump();

      expect(find.text(envelopeFailure.message), findsOneWidget);
      expect(find.text(en('common.error')), findsOneWidget);
    });

    testWidgets('a PROXY 502 renders something a human can act on, and never '
        'the raw text or the status code', (tester) async {
      final failure = proxyFailure();
      await pumpLifeScreen(
        tester,
        const CoachingScreen(childId: 'child_1', childName: 'سلمى'),
        repository: FakeLifeIntelligenceRepository(
          onGetCoachingRecommendations: () => failingWith<List<dynamic>>(failure),
        ),
      );
      await tester.pump();

      expect(find.byType(DsErrorState), findsOneWidget);
      expect(find.text(ApiFailure.unexpected.messageAr!), findsOneWidget);
      // The three things that must never appear.
      expect(find.textContaining('502'), findsNothing);
      expect(find.textContaining('invalid status code'), findsNothing);
      expect(find.textContaining('DioException'), findsNothing);
      // And a way out of it.
      expect(find.text(ar('common.retry')), findsOneWidget);
    });

    testWidgets('a DROPPED SOCKET is told apart from a server refusal',
        (tester) async {
      await pumpLifeScreen(
        tester,
        const CoachingScreen(childId: 'child_1', childName: 'سلمى'),
        repository: FakeLifeIntelligenceRepository(
          onGetCoachingRecommendations: () =>
              failingWith<List<dynamic>>(droppedSocketFailure()),
        ),
      );
      await tester.pump();

      expect(find.text(ApiFailure.offline.messageAr!), findsOneWidget);
      expect(find.textContaining('Connection closed'), findsNothing);
      // The offline case earns its own icon, so the two are distinguishable
      // at a glance and not only by reading.
      expect(find.byIcon(Icons.wifi_off_rounded), findsOneWidget);
    });

    testWidgets('the requestId is ON SCREEN for support, but is not the '
        'headline', (tester) async {
      await pumpLifeScreen(
        tester,
        const CoachingScreen(childId: 'child_1', childName: 'سلمى'),
        repository: FakeLifeIntelligenceRepository(
          onGetCoachingRecommendations: () => failingWith<List<dynamic>>(envelopeFailure),
        ),
      );
      await tester.pump();

      final idFinder = find.text('${ar('common.requestId')} ${envelopeFailure.requestId}');
      expect(idFinder, findsOneWidget);

      // NOT THE HEADLINE, structurally rather than by eyeballing it:
      // the request id is selectable small print (so it can be copied into a
      // support ticket), while the sentence a parent reads is ordinary body
      // text — and the id is rendered strictly smaller than that sentence.
      final idWidget = tester.widget<SelectableText>(
        find.byType(SelectableText).first,
      );
      expect(idWidget.data, contains(envelopeFailure.requestId!));

      final messageStyle = tester.widget<Text>(find.text(envelopeFailure.messageAr!)).style;
      expect(idWidget.style?.fontSize, isNotNull);
      expect(idWidget.style!.fontSize! < (messageStyle?.fontSize ?? 14), isTrue);
    });

    testWidgets('retry re-asks the repository', (tester) async {
      var calls = 0;
      await pumpLifeScreen(
        tester,
        const CoachingScreen(childId: 'child_1', childName: 'سلمى'),
        repository: FakeLifeIntelligenceRepository(
          onGetCoachingRecommendations: () {
            calls++;
            return failingWith<List<dynamic>>(envelopeFailure);
          },
        ),
      );
      await tester.pump();
      expect(calls, 1);

      await tester.tap(find.text(ar('common.retry')));
      // One frame per `await` in the reload chain — deliberately counted
      // rather than `pumpAndSettle`, which never returns while the loading
      // spinner is on screen.
      await tester.pump();
      await tester.pump();
      await tester.pump();

      expect(calls, 2);
    });
  });

  // =========================================================================
  group('HealthTrendScreen — a detail-shaped screen', () {
    testWidgets('renders the server Arabic when the score cannot be read',
        (tester) async {
      await pumpLifeScreen(
        tester,
        const HealthTrendScreen(childId: 'child_1', childName: 'سلمى'),
        repository: FakeLifeIntelligenceRepository(
          onGetHealthScore: () => failingWith<Map<String, dynamic>>(envelopeFailure),
        ),
      );
      await tester.pump();

      expect(find.text(envelopeFailure.messageAr!), findsOneWidget);
      expect(find.text(envelopeFailure.message), findsNothing);
    });

    testWidgets('a partial breakdown degrades to the screen\'s own "not '
        'logged" copy instead of throwing inside build', (tester) async {
      await pumpLifeScreen(
        tester,
        const HealthTrendScreen(childId: 'child_1', childName: 'سلمى'),
        repository: FakeLifeIntelligenceRepository(
          // A real shape: the device has not synced, so the engine returns a
          // score with an empty breakdown. This used to be four unchecked
          // casts in a row.
          onGetHealthScore: () async => <String, dynamic>{
            'score': 62,
            'breakdown': <String, dynamic>{},
          },
        ),
      );
      await tester.pump();

      expect(tester.takeException(), isNull);
      expect(find.text('62'), findsOneWidget);
      expect(find.text(ar('healthTrend.notLogged')), findsWidgets);
    });

    testWidgets('the hydration unit is localised, not a hardcoded "ml"',
        (tester) async {
      await pumpLifeScreen(
        tester,
        const HealthTrendScreen(childId: 'child_1', childName: 'سلمى'),
        repository: FakeLifeIntelligenceRepository(
          onGetHealthScore: () async => <String, dynamic>{
            'score': 70,
            'breakdown': <String, dynamic>{
              'hydration': <String, dynamic>{'actualMl': 500, 'targetMl': 1500},
            },
          },
        ),
      );
      await tester.pump();

      expect(find.text('500 / 1500 ${ar('healthTrend.millilitres')}'), findsOneWidget);
    });
  });

  // =========================================================================
  group('WellbeingScreen — an honest absence is not a failure', () {
    testWidgets('a null snapshot renders the "no data yet" copy, NOT the '
        'error state', (tester) async {
      await pumpLifeScreen(
        tester,
        const WellbeingScreen(childId: 'child_1', childName: 'سلمى'),
        repository: FakeLifeIntelligenceRepository(
          onGetWellbeingSnapshot: () async => null,
          onGetWellbeingInsight: () async => null,
        ),
      );
      await tester.pump();

      expect(find.text(ar('wellbeing.noData')), findsOneWidget);
      expect(find.byType(DsErrorState), findsNothing);
    });

    testWidgets('a thrown error renders the error state, NOT the "no data '
        'yet" copy', (tester) async {
      await pumpLifeScreen(
        tester,
        const WellbeingScreen(childId: 'child_1', childName: 'سلمى'),
        repository: FakeLifeIntelligenceRepository(
          onGetWellbeingSnapshot: () => failingWith<Map<String, dynamic>?>(envelopeFailure),
        ),
      );
      await tester.pump();

      expect(find.byType(DsErrorState), findsOneWidget);
      expect(find.text(envelopeFailure.messageAr!), findsOneWidget);
      expect(find.text(ar('wellbeing.noData')), findsNothing);
    });

    testWidgets('a failing INSIGHT never blanks the averages that already '
        'rendered', (tester) async {
      await pumpLifeScreen(
        tester,
        const WellbeingScreen(childId: 'child_1', childName: 'سلمى'),
        repository: FakeLifeIntelligenceRepository(
          onGetWellbeingSnapshot: () async => <String, dynamic>{
            'averageDailyScreenMinutes': 180,
            'averagePickups': 42,
            'averageNightUsageMinutes': 15,
            'totalBlockedAttempts': 2,
            'windowDays': 7,
            'daysWithData': 5,
          },
          onGetWellbeingInsight: () => failingWith<Map<String, dynamic>?>(proxyFailure()),
        ),
      );
      await tester.pump();
      await tester.pump();

      expect(find.byType(DsErrorState), findsNothing);
      expect(find.text('42'), findsOneWidget);
      expect(find.text('180 ${ar('wellbeing.minutesPerDay')}'), findsOneWidget);
    });
  });

  // =========================================================================
  group('PendingApprovalsScreen — the category is a backend enum', () {
    Future<void> pumpWithCategory(WidgetTester tester, String category) {
      return pumpLifeScreen(
        tester,
        const PendingApprovalsScreen(),
        repository: FakeLifeIntelligenceRepository(
          onGetPendingMessages: () async => [
            {
              'id': 'msg_1',
              'childId': 'child_1',
              'childName': 'سلمى',
              'title': 'أحسنت!',
              'body': 'واظبت على شرب الماء اليوم.',
              'category': category,
            },
          ],
        ),
      );
    }

    testWidgets('a known notification type is shown as a label, never as the '
        'raw token', (tester) async {
      await pumpWithCategory(tester, 'STREAK_ACHIEVED');
      await tester.pump();

      expect(find.text(ar('messageCategory.STREAK_ACHIEVED')), findsOneWidget);
      expect(find.text('STREAK_ACHIEVED'), findsNothing);
      // The message itself is server-authored Arabic and renders verbatim.
      expect(find.text('أحسنت!'), findsOneWidget);
    });

    testWidgets('a type this build has never heard of falls back to a real '
        'word rather than leaking the token', (tester) async {
      await pumpWithCategory(tester, 'SOME_FUTURE_TYPE');
      await tester.pump();

      expect(find.text(ar('messageCategory.other')), findsOneWidget);
      expect(find.text('SOME_FUTURE_TYPE'), findsNothing);
      expect(find.textContaining('messageCategory.'), findsNothing);
    });

    testWidgets('a refused approval shows the server\'s sentence and KEEPS '
        'the queue readable', (tester) async {
      var listCalls = 0;
      await pumpLifeScreen(
        tester,
        const PendingApprovalsScreen(),
        repository: FakeLifeIntelligenceRepository(
          onGetPendingMessages: () async {
            listCalls++;
            return [
              {
                'id': 'msg_1',
                'childId': 'child_1',
                'childName': 'سلمى',
                'title': 'أحسنت!',
                'body': 'واظبت على شرب الماء اليوم.',
                'category': 'STREAK_ACHIEVED',
              },
            ];
          },
          onApproveMessage: () => failingWith<void>(envelopeFailure),
        ),
      );
      await tester.pump();

      await tester.tap(find.text(ar('pendingApprovals.approve')));
      // approve -> catch -> reload -> clear the busy flag: one frame per
      // `await` in `_decide`.
      await tester.pump();
      await tester.pump();
      await tester.pump();
      await tester.pump();

      expect(find.text(envelopeFailure.messageAr!), findsOneWidget);
      expect(find.text(ar('lifeIntelligence.actionFailedTitle')), findsOneWidget);
      // The refusal is a banner, not a takeover: the queue is still there.
      expect(find.text('أحسنت!'), findsOneWidget);
      // And the list was re-read, because the server decides what is still
      // pending — not this screen.
      expect(listCalls, 2);
    });
  });

  // =========================================================================
  group('HabitTrackerScreen — the habit category', () {
    testWidgets('a known category token is shown as a label', (tester) async {
      await pumpLifeScreen(
        tester,
        const HabitTrackerScreen(childId: 'child_1', childName: 'سلمى'),
        repository: FakeLifeIntelligenceRepository(
          onGetHabits: () async => [
            {'id': 'h1', 'title': 'صلاة الفجر', 'category': 'HEALTH', 'isShared': false},
          ],
        ),
      );
      await tester.pump();

      expect(find.text(ar('category.HEALTH')), findsOneWidget);
      expect(find.text('HEALTH'), findsNothing);
    });

    testWidgets('a free-text category is parent-authored content and renders '
        'as written', (tester) async {
      await pumpLifeScreen(
        tester,
        const HabitTrackerScreen(childId: 'child_1', childName: 'سلمى'),
        repository: FakeLifeIntelligenceRepository(
          onGetHabits: () async => [
            {'id': 'h1', 'title': 'ترتيب الغرفة', 'category': 'ترتيب', 'isShared': false},
          ],
        ),
      );
      await tester.pump();

      expect(find.text('ترتيب'), findsOneWidget);
      expect(find.textContaining('category.'), findsNothing);
    });
  });

  // =========================================================================
  group('DigitalTwinScreen — the sub-score inputs', () {
    testWidgets('never prints a backend enum or field name into the '
        'expansion panel', (tester) async {
      await pumpLifeScreen(
        tester,
        const DigitalTwinScreen(childId: 'child_1', childName: 'سلمى'),
        repository: FakeLifeIntelligenceRepository(
          // The REAL safety slice shape, from digital-twin.service.ts.
          onGetDigitalTwin: () async => <String, dynamic>{
            'growthScore': <String, dynamic>{
              'score': 74,
              'inputs': <String, dynamic>{
                'contributingSubScores': 3,
                'totalPossibleSubScores': 7,
              },
            },
            'safety': <String, dynamic>{
              'score': 80,
              'inputs': <String, dynamic>{
                'overallRisk': 12,
                'overallLevel': 'HIGH',
                'reasons': ['UNKNOWN_APP_INSTALLED'],
              },
            },
          },
        ),
      );
      await tester.pump();

      // Expand the Safety tile. It is the last of seven, so it has to be
      // scrolled to before it can be tapped in an 800x600 test window.
      final safetyTile = find.text(ar('digitalTwin.safety'));
      await tester.ensureVisible(safetyTile);
      await tester.pumpAndSettle();
      await tester.tap(safetyTile);
      await tester.pumpAndSettle();

      // The numeric input with a reviewed label survives...
      expect(find.text('${ar('digitalTwinInput.overallRisk')}: 12'), findsOneWidget);
      // ...and the enum, the field names and the list do not appear at all.
      expect(find.textContaining('HIGH'), findsNothing);
      expect(find.textContaining('overallLevel'), findsNothing);
      expect(find.textContaining('UNKNOWN_APP_INSTALLED'), findsNothing);
      expect(find.textContaining('reasons'), findsNothing);
    });

    testWidgets('a growthScore with no numeric score does not throw inside '
        'build', (tester) async {
      await pumpLifeScreen(
        tester,
        const DigitalTwinScreen(childId: 'child_1', childName: 'سلمى'),
        repository: FakeLifeIntelligenceRepository(
          onGetDigitalTwin: () async => <String, dynamic>{
            'growthScore': <String, dynamic>{'inputs': <String, dynamic>{}},
          },
        ),
      );
      await tester.pump();

      expect(tester.takeException(), isNull);
      expect(find.text(ar('digitalTwin.notYetAvailable')), findsWidgets);
    });

    testWidgets('renders the server Arabic when the twin cannot be read',
        (tester) async {
      await pumpLifeScreen(
        tester,
        const DigitalTwinScreen(childId: 'child_1', childName: 'سلمى'),
        repository: FakeLifeIntelligenceRepository(
          onGetDigitalTwin: () => failingWith<Map<String, dynamic>>(envelopeFailure),
        ),
      );
      await tester.pump();

      expect(find.text(envelopeFailure.messageAr!), findsOneWidget);
      expect(find.text(envelopeFailure.message), findsNothing);
    });
  });
}
