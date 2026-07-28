enum AgentPermissionKind {
  usageAccess,
  accessibilityService,
  overlay,
  batteryOptimization,
  notifications,
}

class PermissionStatus {
  const PermissionStatus({required this.kind, required this.isGranted, required this.label});

  final AgentPermissionKind kind;
  final bool isGranted;
  final String label;
}
