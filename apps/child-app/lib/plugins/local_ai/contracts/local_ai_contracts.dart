/// Sprint 4 (Child Runtime Engine) §6 — "initially deterministic/rule-based,
/// later upgradeable to TensorFlow Lite/ONNX/MediaPipe... the interface
/// must already support that evolution." Every contract below is written
/// so a future ML-backed implementation can satisfy it without any
/// caller changing — same discipline as `IRiskDetector` (Step 1).
///
/// ONLY `ILocalRuleEngine` has a real implementation this session
/// (`DeterministicRuleEngine`). The rest are declared, not implemented —
/// each would need its own dedicated, carefully-scoped pass (behavior
/// pattern detection over real usage history, a keyword list with real
/// safety review, etc.) rather than a placeholder that looks done but
/// isn't.

enum PolicyEvaluationDecision { allow, block, warn }

class PolicyEvaluationResult {
  const PolicyEvaluationResult({required this.decision, required this.reason});
  final PolicyEvaluationDecision decision;
  final String reason;
}

/// The one real implementation this session — evaluates the cached
/// policy (plugins/policy/) against the current time. See
/// DeterministicRuleEngine.
abstract class ILocalRuleEngine {
  PolicyEvaluationResult evaluate({
    required DateTime now,
    required int? dailyLimitMinutes,
    required int minutesUsedToday,
    required String? bedtimeStart,
    required String? bedtimeEnd,
  });
}

/// Declared only. Would detect trends like "180% increase in night-time
/// usage over 2 weeks" (Decision-068's own example) — needs real
/// historical usage data (Step 10's App Usage Collection, not built) to
/// be meaningful; implementing this now would be a placeholder, not a
/// feature.
abstract class IBehaviorPatternDetector {
  Future<List<String>> detectPatterns(String childId);
}

/// Declared only. Deliberately NOT implemented with a hardcoded keyword
/// list in this pass — a real safety-word list needs product/safety
/// review, not an engineering guess embedded in a rush.
abstract class IKeywordClassifier {
  bool isFlagged(String text);
}

abstract class IRecommendationEngine {
  Future<String> recommend(String childId);
}

/// Declared only — would score how much to trust another Local AI
/// Runtime component's output (e.g. weighting IKeywordClassifier's
/// false-positive-prone raw match against corroborating signals).
abstract class IConfidenceEngine {
  double scoreConfidence(String signalSource, Map<String, dynamic> signalData);
}

abstract class ISafetyClassifier {
  Future<bool> isContentSafe(String content);
}
