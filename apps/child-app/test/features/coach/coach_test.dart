import 'package:flutter_test/flutter_test.dart';

import 'package:child_app/core/errors/api_failure.dart';
import 'package:child_app/core/network/api_client.dart';
import 'package:child_app/core/network/api_exception.dart';
import 'package:child_app/features/coach/api/coach_api.dart';
import 'package:child_app/features/coach/application/coach_controller.dart';
import 'package:child_app/features/coach/data/coach_repository.dart';
import 'package:child_app/features/coach/domain/coach_models.dart';

/// THE COACH TAB — `/self/coach/*`.
///
/// These tests exist for two different reasons and it is worth keeping them
/// apart. Most of them are ordinary state-machine tests. Two of them —
/// «the classifier is unobservable» and «free text reaches exactly one
/// path» — are guarding PRODUCT DECISIONS that live in the backend and that
/// a well-meaning UI change could quietly undo from this side.

/// Records every path the API layer asks for, so a test can assert where a
/// child's words can and cannot travel. `noSuchMethod` covers the rest of
/// [ApiClient]'s surface, which this feature does not touch.
class _RecordingClient implements ApiClient {
  final List<String> getPaths = [];
  final List<String> postPaths = [];
  final List<Map<String, dynamic>?> postBodies = [];

  Map<String, dynamic> Function(String path)? onGet;
  Map<String, dynamic> Function(String path)? onPost;

  @override
  Future<Map<String, dynamic>> get(String path) async {
    getPaths.add(path);
    return onGet?.call(path) ?? <String, dynamic>{};
  }

  @override
  Future<Map<String, dynamic>> post(
    String path, {
    Map<String, dynamic>? body,
    bool skipAuth = false,
  }) async {
    postPaths.add(path);
    postBodies.add(body);
    return onPost?.call(path) ?? <String, dynamic>{};
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

/// A repository stub. `implements` rather than a subclass so no real
/// [ChildCoachApi] — and therefore no Dio — is constructed in these tests.
class _FakeRepository implements ChildCoachRepository {
  _FakeRepository({
    this.encouragement,
    this.topics = const [],
    this.answersByCode = const {},
    this.checkinOutcome,
    this.todayFailure,
    this.answerFailure,
    this.checkinFailure,
  });

  ChildEncouragement? encouragement;
  List<CoachTopic> topics;
  Map<String, CoachAnswer> answersByCode;
  CheckinOutcome? checkinOutcome;
  ApiFailure? todayFailure;
  ApiFailure? answerFailure;
  ApiFailure? checkinFailure;

  int todayCalls = 0;
  int topicsCalls = 0;
  final List<String> answerCalls = [];
  final List<String> checkinTexts = [];

  @override
  Future<ChildEncouragement> today() async {
    todayCalls++;
    if (todayFailure != null) throw todayFailure!;
    return encouragement ??
        const ChildEncouragement(
          intent: CoachIntent.nudge,
          messageAr: 'مهمة واحدة تكفي.',
          ageBand: '9-11',
          businessDate: '2026-08-17',
        );
  }

  @override
  Future<List<CoachTopic>> topics() async {
    topicsCalls++;
    return topics;
  }

  @override
  Future<CoachAnswer> answer(String topicCode) async {
    answerCalls.add(topicCode);
    if (answerFailure != null) throw answerFailure!;
    return answersByCode[topicCode] ??
        CoachAnswer(code: topicCode, answerAr: 'إجابة $topicCode', ageBand: '9-11');
  }

  @override
  Future<CheckinOutcome> checkin(String feeling) async {
    checkinTexts.add(feeling);
    if (checkinFailure != null) throw checkinFailure!;
    return checkinOutcome ?? const CheckinOutcome(escalated: false);
  }
}

const _celebrateJson = {
  'intent': 'CELEBRATE',
  'ageBand': '9-11',
  'messageAr': 'أكملت 4 أيام متتالية. استمر.',
  'phrasedByAi': false,
  'businessDate': '2026-08-17',
};

void main() {
  group('ChildCoachRepository', () {
    test('unwraps {topics: [...]} and drops rows that cannot be rendered', () async {
      final client = _RecordingClient()
        ..onGet = (_) => {
              'topics': [
                {'code': 'WHAT_IS_A_STREAK', 'questionAr': 'يعني إيه سلسلة؟'},
                // No question — a blank tap target.
                {'code': 'HOW_DO_POINTS_WORK', 'questionAr': '   '},
                // No code — nothing to send back, so nothing to answer.
                {'questionAr': 'سؤال بلا كود'},
              ],
            };
      final repository = ChildCoachRepository(ChildCoachApi(client));

      final topics = await repository.topics();

      expect(topics, hasLength(1));
      expect(topics.single.code, 'WHAT_IS_A_STREAK');
    });

    test('returns an empty list rather than throwing when `topics` is not a list', () async {
      final client = _RecordingClient()..onGet = (_) => {'topics': 'nope'};
      final repository = ChildCoachRepository(ChildCoachApi(client));

      expect(await repository.topics(), isEmpty);
    });

    test('carries messageAr across the boundary — a child never reads the English', () async {
      final client = _RecordingClient()
        ..onGet = (_) => throw ApiException(
              'Unknown coach topic.',
              400,
              code: 'UNKNOWN_COACH_TOPIC',
              messageAr: 'هذا السؤال غير متاح. اختر سؤالًا من القائمة.',
            );
      final repository = ChildCoachRepository(ChildCoachApi(client));

      await expectLater(
        repository.answer('MADE_UP'),
        throwsA(
          isA<ApiFailure>()
              .having((f) => f.display, 'display', 'هذا السؤال غير متاح. اختر سؤالًا من القائمة.')
              .having((f) => f.code, 'code', 'UNKNOWN_COACH_TOPIC'),
        ),
      );
    });
  });

  group('ChildCoachApi — where a child\'s words are allowed to travel', () {
    test('the ONLY path that ever carries free text is /self/coach/checkin', () async {
      final client = _RecordingClient()
        ..onGet = (_) => Map<String, dynamic>.from(_celebrateJson)
        ..onPost = (_) => {'escalated': false, 'card': null, 'encouragement': _celebrateJson};
      final api = ChildCoachApi(client);

      await api.today();
      await api.topics();
      await api.answer('WHAT_IS_A_STREAK');
      await api.checkin('أنا حاسس إني تعبان');

      // Every GET is a fixed path or a path built from a server-supplied
      // enum member. None of them carries anything the child typed.
      expect(client.getPaths, [
        '/self/coach/today',
        '/self/coach/topics',
        '/self/coach/answer/WHAT_IS_A_STREAK',
      ]);
      expect(
        client.getPaths.any((p) => p.contains('حاسس')),
        isFalse,
        reason: 'child free text must never appear in a URL',
      );

      // And exactly one POST, carrying it in the body of the one route that
      // classifies offline and stores nothing.
      expect(client.postPaths, ['/self/coach/checkin']);
      expect(client.postBodies.single, {'feeling': 'أنا حاسس إني تعبان'});
    });

    test('no method sends a childId — the server derives it from the device token', () async {
      final client = _RecordingClient()
        ..onGet = (_) => Map<String, dynamic>.from(_celebrateJson)
        ..onPost = (_) => {'escalated': false};
      final api = ChildCoachApi(client);

      await api.today();
      await api.answer('WHAT_IS_A_TASK');
      await api.checkin('تمام');

      final everything = [...client.getPaths, ...client.postPaths];
      expect(everything.any((p) => p.toLowerCase().contains('child')), isFalse);
      for (final body in client.postBodies) {
        expect(body?.keys, isNot(contains('childId')));
      }
    });
  });

  group('CoachController', () {
    test('loads today\'s card and the question list together', () async {
      final repository = _FakeRepository(
        topics: const [CoachTopic(code: 'WHAT_IS_A_STREAK', questionAr: 'يعني إيه سلسلة؟')],
      );
      final controller = CoachController(repository);
      await Future<void>.delayed(Duration.zero);

      expect(controller.state.home.hasData, isTrue);
      expect(controller.state.home.valueOrNull!.topics, hasLength(1));
      expect(repository.todayCalls, 1);
      expect(repository.topicsCalls, 1);
    });

    test('a failed load leaves an error state carrying the server\'s own sentence', () async {
      final repository = _FakeRepository(
        todayFailure: const ApiFailure(message: 'boom', messageAr: 'حصل خطأ.'),
      );
      final controller = CoachController(repository);
      await Future<void>.delayed(Duration.zero);

      expect(controller.state.home.isError, isTrue);
      expect(controller.state.home.failure!.display, 'حصل خطأ.');
    });

    test('opening a question fetches it once; re-opening it does not hit the endpoint again',
        () async {
      final repository = _FakeRepository(
        topics: const [CoachTopic(code: 'WHAT_IS_A_TASK', questionAr: 'يعني إيه مهمة؟')],
      );
      final controller = CoachController(repository);
      await Future<void>.delayed(Duration.zero);

      await controller.openTopic('WHAT_IS_A_TASK');
      expect(controller.state.openTopicCode, 'WHAT_IS_A_TASK');
      expect(controller.state.answers['WHAT_IS_A_TASK'], isNotNull);

      // Closes.
      await controller.openTopic('WHAT_IS_A_TASK');
      expect(controller.state.openTopicCode, isNull);

      // Re-opens from cache.
      await controller.openTopic('WHAT_IS_A_TASK');
      expect(controller.state.openTopicCode, 'WHAT_IS_A_TASK');
      expect(repository.answerCalls, ['WHAT_IS_A_TASK'], reason: 'answered once, cached after');
    });

    test('a refused answer does not blank the card the child is already reading', () async {
      final repository = _FakeRepository(
        topics: const [CoachTopic(code: 'WHAT_IS_A_TASK', questionAr: 'يعني إيه مهمة؟')],
        answerFailure: const ApiFailure(
          message: 'Unknown coach topic.',
          messageAr: 'هذا السؤال غير متاح. اختر سؤالًا من القائمة.',
          code: 'UNKNOWN_COACH_TOPIC',
          statusCode: 400,
        ),
      );
      final controller = CoachController(repository);
      await Future<void>.delayed(Duration.zero);

      await controller.openTopic('WHAT_IS_A_TASK');

      expect(controller.state.home.hasData, isTrue, reason: 'today\'s card survives');
      expect(controller.state.answerFailure!.display,
          'هذا السؤال غير متاح. اختر سؤالًا من القائمة.');
      expect(controller.state.answerLoadingCode, isNull);
    });

    test('an empty check-in is never sent', () async {
      final repository = _FakeRepository();
      final controller = CoachController(repository);
      await Future<void>.delayed(Duration.zero);

      await controller.submitCheckin('   ');

      expect(repository.checkinTexts, isEmpty);
    });

    test('the check-in field ceiling matches ChildCheckinDto\'s @Length(1, 500)', () {
      expect(CoachController.checkinMaxLength, 500);
    });

    /// THE PROPERTY THIS WHOLE FILE EXISTS FOR.
    ///
    /// On no distress signal the server returns today's ORDINARY
    /// encouragement — the same card `GET today` would have returned. If the
    /// client set any state on that branch that it does not set on a plain
    /// load (a "thanks", a flag, a different card style), a child could learn
    /// what the classifier reacts to by watching the screen change.
    test('a non-escalated check-in leaves NOTHING a child could read as a verdict', () async {
      final repository = _FakeRepository(
        topics: const [CoachTopic(code: 'WHAT_IS_A_STREAK', questionAr: 'يعني إيه سلسلة؟')],
        checkinOutcome: const CheckinOutcome(
          escalated: false,
          card: null,
          encouragement: ChildEncouragement(
            intent: CoachIntent.celebrate,
            messageAr: 'أكملت 4 أيام متتالية. استمر.',
            ageBand: '9-11',
            businessDate: '2026-08-17',
          ),
        ),
      );
      final controller = CoachController(repository);
      await Future<void>.delayed(Duration.zero);

      await controller.submitCheckin('أنا زعلان النهاردة');

      expect(controller.state.safetyCard, isNull);
      expect(controller.state.checkinFailure, isNull);
      expect(controller.state.checkinSubmitting, isFalse);
      // The card was REPLACED by the server's — rendered through the same
      // widget, with no extra marker of any kind.
      expect(
        controller.state.home.valueOrNull!.encouragement.messageAr,
        'أكملت 4 أيام متتالية. استمر.',
      );
      expect(controller.state.home.valueOrNull!.topics, hasLength(1));
    });

    test('an escalated check-in shows the server\'s fixed card and its helplines', () async {
      final repository = _FakeRepository(
        checkinOutcome: const CheckinOutcome(
          escalated: true,
          card: DistressCard(
            titleAr: 'شكرًا لأنك كتبت هذا',
            bodyAr: 'ما كتبته مهم، وأنت لست وحدك.',
            helplines: [
              CoachHelpline(country: 'EG', labelAr: 'خط نجدة الطفل — مصر', number: '16000'),
              CoachHelpline(country: 'SA', labelAr: 'خط الأمان الأسري — السعودية', number: '1919'),
            ],
          ),
        ),
      );
      final controller = CoachController(repository);
      await Future<void>.delayed(Duration.zero);

      await controller.submitCheckin('مش عارف أعمل إيه');

      final card = controller.state.safetyCard;
      expect(card, isNotNull);
      expect(card!.titleAr, 'شكرًا لأنك كتبت هذا');
      expect(card.helplines.map((h) => h.number), ['16000', '1919']);
    });

    test('dismissing the safety card clears only the card — the parent alert is not the child\'s to withdraw',
        () async {
      final repository = _FakeRepository(
        checkinOutcome: const CheckinOutcome(
          escalated: true,
          card: DistressCard(titleAr: 'عنوان', bodyAr: 'نص', helplines: []),
        ),
      );
      final controller = CoachController(repository);
      await Future<void>.delayed(Duration.zero);
      await controller.submitCheckin('كلام');

      controller.dismissSafetyCard();

      expect(controller.state.safetyCard, isNull);
      expect(repository.checkinTexts, hasLength(1), reason: 'no second call was made');
    });
  });

  group('coach models', () {
    test('an intent this client has never seen degrades to a mood, not to an error', () {
      final parsed = ChildEncouragement.fromJson({
        'intent': 'SOMETHING_NEW',
        'messageAr': 'رسالة',
        'ageBand': '6-8',
        'businessDate': '2026-08-17',
      });

      expect(parsed.intent, CoachIntent.unknown);
      expect(parsed.messageAr, 'رسالة', reason: 'the sentence still arrives');
    });

    test('a check-in response with neither branch populated does not crash the parser', () {
      final parsed = CheckinOutcome.fromJson(const {'escalated': false});

      expect(parsed.escalated, isFalse);
      expect(parsed.card, isNull);
      expect(parsed.encouragement, isNull);
    });
  });
}
