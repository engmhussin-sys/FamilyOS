enum AgentPermissionKind {
  usageAccess,
  accessibilityService,
  overlay,
  batteryOptimization,
  notifications,
}

/// G18 — the answer to a POST_NOTIFICATIONS request.
///
/// MUST mirror `AgentChannel.NotificationPermissionOutcome` in
/// android/.../core/AgentChannel.kt. There is no compile-time link between the
/// two languages, so a mismatch is a silent runtime failure — the same reason
/// both sides keep their channel method names as named constants.
///
/// NOT a bool, deliberately: "declined once" and "declined for good" need
/// different handling (ask again another day vs. offer the settings route), and
/// a bool cannot tell them apart. That is how an app ends up shipping a button
/// which silently does nothing.
enum NotificationPermissionOutcome {
  /// Below Android 13 the permission is granted at install time. No dialog.
  notRequired,

  /// Already granted before we asked. No dialog was shown.
  alreadyGranted,

  /// The child saw the system dialog and allowed.
  granted,

  /// The child declined. Android will still show the dialog another time.
  denied,

  /// Android will not show the dialog again. Only this app's own notification
  /// settings screen can change the answer now.
  permanentlyDenied;

  /// TOTAL by design: an unrecognised wire value becomes [denied] rather than
  /// throwing. "I do not understand this answer" honestly reads as "not
  /// granted", and an exception thrown inside a permission handler is a far
  /// worse outcome than a conservative assumption.
  static NotificationPermissionOutcome fromWire(String? wire) {
    switch (wire) {
      case 'not_required':
        return NotificationPermissionOutcome.notRequired;
      case 'already_granted':
        return NotificationPermissionOutcome.alreadyGranted;
      case 'granted':
        return NotificationPermissionOutcome.granted;
      case 'permanently_denied':
        return NotificationPermissionOutcome.permanentlyDenied;
      case 'denied':
      default:
        return NotificationPermissionOutcome.denied;
    }
  }

  /// True when a notification can actually be posted after this outcome.
  bool get isUsable =>
      this == NotificationPermissionOutcome.granted ||
      this == NotificationPermissionOutcome.alreadyGranted ||
      this == NotificationPermissionOutcome.notRequired;
}

class PermissionStatus {
  const PermissionStatus({
    required this.kind,
    required this.isGranted,
    required this.label,
    required this.labelKey,
  });

  final AgentPermissionKind kind;
  final bool isGranted;

  /// English engineering label. Kept for logs and diagnostics only.
  final String label;

  /// F2: localisation key for what the CHILD actually sees. The previous
  /// code rendered [label] directly, so an Arabic-first app showed
  /// "Accessibility Service" — a phrase that means nothing to a
  /// nine-year-old and reads as technical jargon to a parent (audit
  /// MA-005's finding, in the Flutter layer rather than the native one).
  final String labelKey;
}
