/// Decision-016's `IRiskDetector` / Decision-010's "AI Inside Agent."
///
/// The contract deliberately returns only a [RiskScore], never raw
/// content — this is what Decision-010's stated privacy benefit actually
/// requires structurally, not just as a policy promise: an
/// implementation of this interface is architecturally unable to leak
/// raw text/content through this API even if it wanted to, because the
/// return type doesn't carry it.
///
/// No concrete implementation exists yet, and per this project's honest
/// scoping elsewhere (see docs/architecture/ai-assistant-module.md's "no
/// RAG until it's actually needed" reasoning, and
/// child-agent-android-enforcement.md §10's Keyboard Behavior Analysis
/// risk notes): a real on-device model is a substantial follow-on
/// project, not a Step 2-adjacent task. This interface exists now so
/// that whenever that project happens, it has a contract to implement
/// rather than needing to retrofit one into whatever code exists by then.
abstract class IRiskDetector {
  /// [signal] is intentionally typed as opaque local input (e.g. a
  /// feature vector, not raw text) — what counts as "signal" is an
  /// implementation detail of whichever concrete on-device model
  /// eventually implements this.
  Future<RiskScore> assess(covariant Object signal);
}

class RiskScore {
  const RiskScore({required this.category, required this.score, required this.assessedAt});

  final RiskCategory category;

  /// 0–100, higher = higher risk. Never a raw excerpt of the input that
  /// produced it — matches the backend's AiRiskScore/AiAlert design
  /// (docs/database/README.md), which stores conclusions, not content.
  final int score;
  final DateTime assessedAt;
}

enum RiskCategory { cyberbullying, predatorRisk, contentRisk, other }
