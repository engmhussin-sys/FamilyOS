import 'package:flutter_test/flutter_test.dart';

import 'package:child_app/plugins/local_ai/application/deterministic_rule_engine.dart';
import 'package:child_app/plugins/local_ai/contracts/local_ai_contracts.dart';

void main() {
  group('DeterministicRuleEngine', () {
    late DeterministicRuleEngine engine;

    setUp(() {
      engine = DeterministicRuleEngine();
    });

    test('allows when under the daily limit and outside bedtime', () {
      final result = engine.evaluate(
        now: DateTime(2026, 7, 28, 15, 0),
        dailyLimitMinutes: 120,
        minutesUsedToday: 30,
        bedtimeStart: '21:00',
        bedtimeEnd: '07:00',
      );
      expect(result.decision, PolicyEvaluationDecision.allow);
    });

    test('warns at 90% of the daily limit', () {
      final result = engine.evaluate(
        now: DateTime(2026, 7, 28, 15, 0),
        dailyLimitMinutes: 100,
        minutesUsedToday: 91,
        bedtimeStart: null,
        bedtimeEnd: null,
      );
      expect(result.decision, PolicyEvaluationDecision.warn);
    });

    test('blocks once the daily limit is reached', () {
      final result = engine.evaluate(
        now: DateTime(2026, 7, 28, 15, 0),
        dailyLimitMinutes: 100,
        minutesUsedToday: 100,
        bedtimeStart: null,
        bedtimeEnd: null,
      );
      expect(result.decision, PolicyEvaluationDecision.block);
      expect(result.reason, contains('limit'));
    });

    test('allows unlimited usage when dailyLimitMinutes is null', () {
      final result = engine.evaluate(
        now: DateTime(2026, 7, 28, 15, 0),
        dailyLimitMinutes: null,
        minutesUsedToday: 999,
        bedtimeStart: null,
        bedtimeEnd: null,
      );
      expect(result.decision, PolicyEvaluationDecision.allow);
    });

    group('overnight bedtime window (21:00–07:00)', () {
      test('blocks at 23:00 (within the overnight window)', () {
        final result = engine.evaluate(
          now: DateTime(2026, 7, 28, 23, 0),
          dailyLimitMinutes: null,
          minutesUsedToday: 0,
          bedtimeStart: '21:00',
          bedtimeEnd: '07:00',
        );
        expect(result.decision, PolicyEvaluationDecision.block);
        expect(result.reason, contains('bedtime'));
      });

      test('blocks at 03:00 (past midnight, still within the overnight window)', () {
        final result = engine.evaluate(
          now: DateTime(2026, 7, 28, 3, 0),
          dailyLimitMinutes: null,
          minutesUsedToday: 0,
          bedtimeStart: '21:00',
          bedtimeEnd: '07:00',
        );
        expect(result.decision, PolicyEvaluationDecision.block);
      });

      test('allows at 10:00 (outside the overnight window)', () {
        final result = engine.evaluate(
          now: DateTime(2026, 7, 28, 10, 0),
          dailyLimitMinutes: null,
          minutesUsedToday: 0,
          bedtimeStart: '21:00',
          bedtimeEnd: '07:00',
        );
        expect(result.decision, PolicyEvaluationDecision.allow);
      });

      test('allows exactly at the bedtime end boundary (07:00)', () {
        final result = engine.evaluate(
          now: DateTime(2026, 7, 28, 7, 0),
          dailyLimitMinutes: null,
          minutesUsedToday: 0,
          bedtimeStart: '21:00',
          bedtimeEnd: '07:00',
        );
        expect(result.decision, PolicyEvaluationDecision.allow);
      });
    });

    test('same-day bedtime window (e.g. a nap-time restriction 13:00-15:00) works too', () {
      final withinWindow = engine.evaluate(
        now: DateTime(2026, 7, 28, 14, 0),
        dailyLimitMinutes: null,
        minutesUsedToday: 0,
        bedtimeStart: '13:00',
        bedtimeEnd: '15:00',
      );
      final outsideWindow = engine.evaluate(
        now: DateTime(2026, 7, 28, 16, 0),
        dailyLimitMinutes: null,
        minutesUsedToday: 0,
        bedtimeStart: '13:00',
        bedtimeEnd: '15:00',
      );
      expect(withinWindow.decision, PolicyEvaluationDecision.block);
      expect(outsideWindow.decision, PolicyEvaluationDecision.allow);
    });

    test('bedtime check takes priority over daily-limit check', () {
      final result = engine.evaluate(
        now: DateTime(2026, 7, 28, 23, 0),
        dailyLimitMinutes: 100,
        minutesUsedToday: 5, // well under the limit
        bedtimeStart: '21:00',
        bedtimeEnd: '07:00',
      );
      expect(result.decision, PolicyEvaluationDecision.block);
      expect(result.reason, contains('bedtime'));
    });
  });
}
