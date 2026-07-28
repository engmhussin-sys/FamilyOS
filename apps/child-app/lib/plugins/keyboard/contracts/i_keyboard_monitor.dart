/// Sprint 4 (Child Runtime Engine) §8 — "Design it now. Do NOT implement
/// it yet. Only define the interfaces and event contracts."
///
/// NOTHING in this file has an implementation anywhere in this codebase.
/// This is intentional, not an oversight — keyboard monitoring is one of
/// the most privacy-sensitive capabilities this product could ever add
/// (it is, functionally, a keylogger — even if scoped to safety
/// detection rather than full capture, that framing matters enormously
/// for both Play Store policy and the family's actual trust). It
/// deserves its own dedicated privacy/legal review pass before any
/// native code exists, not a rushed implementation riding along with
/// Sprint 4's other components. See child-runtime-engine.md §8.

class KeyboardActivityEvent {
  const KeyboardActivityEvent({
    required this.packageName,
    required this.wordCount,
    required this.occurredAt,
  });

  final String packageName;

  /// Deliberately a COUNT, not captured text — even at the contract
  /// level, this interface is designed to never need to carry raw
  /// keystrokes through the Event Bus. Any future real implementation
  /// should be evaluated against whether it can stay this way (on-device
  /// classification only, nothing resembling captured text ever leaving
  /// the keyboard-monitoring boundary) as a hard requirement, not a nice-to-have.
  final int wordCount;

  final DateTime occurredAt;
}

abstract class IKeyboardMonitor {
  Stream<KeyboardActivityEvent> get activityDetected;

  Future<void> start();
  Future<void> stop();
}
