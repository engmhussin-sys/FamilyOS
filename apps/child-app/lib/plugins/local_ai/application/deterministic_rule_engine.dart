import '../contracts/local_ai_contracts.dart';

/// The real implementation of [ILocalRuleEngine] — plain deterministic
/// logic, no ML. This is what actually runs TODAY when Track B's Policy
/// Enforcement Engine (once built) needs a decision; a future
/// `TfLiteRuleEngine` would implement the same interface and slot in
/// without any caller changing.
class DeterministicRuleEngine implements ILocalRuleEngine {
  @override
  PolicyEvaluationResult evaluate({
    required DateTime now,
    required int? dailyLimitMinutes,
    required int minutesUsedToday,
    required String? bedtimeStart,
    required String? bedtimeEnd,
  }) {
    if (_isWithinBedtime(now, bedtimeStart, bedtimeEnd)) {
      return const PolicyEvaluationResult(
        decision: PolicyEvaluationDecision.block,
        reason: 'Within bedtime window.',
      );
    }

    if (dailyLimitMinutes != null && minutesUsedToday >= dailyLimitMinutes) {
      return const PolicyEvaluationResult(
        decision: PolicyEvaluationDecision.block,
        reason: 'Daily screen time limit reached.',
      );
    }

    if (dailyLimitMinutes != null && minutesUsedToday >= (dailyLimitMinutes * 0.9).round()) {
      return const PolicyEvaluationResult(
        decision: PolicyEvaluationDecision.warn,
        reason: 'Approaching daily screen time limit.',
      );
    }

    return const PolicyEvaluationResult(
      decision: PolicyEvaluationDecision.allow,
      reason: 'Within policy.',
    );
  }

  bool _isWithinBedtime(DateTime now, String? start, String? end) {
    if (start == null || end == null) return false;

    final nowMinutes = now.hour * 60 + now.minute;
    final startMinutes = _parseTimeToMinutes(start);
    final endMinutes = _parseTimeToMinutes(end);
    if (startMinutes == null || endMinutes == null) return false;

    if (startMinutes <= endMinutes) {
      // Same-day window, e.g. 13:00–15:00.
      return nowMinutes >= startMinutes && nowMinutes < endMinutes;
    }
    // Overnight window, e.g. 21:00–07:00.
    return nowMinutes >= startMinutes || nowMinutes < endMinutes;
  }

  int? _parseTimeToMinutes(String hhmm) {
    final parts = hhmm.split(':');
    if (parts.length != 2) return null;
    final hour = int.tryParse(parts[0]);
    final minute = int.tryParse(parts[1]);
    if (hour == null || minute == null) return null;
    return hour * 60 + minute;
  }
}
