enum AgentPermissionKind {
  usageAccess,
  accessibilityService,
  overlay,
  batteryOptimization,
  notifications,
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
