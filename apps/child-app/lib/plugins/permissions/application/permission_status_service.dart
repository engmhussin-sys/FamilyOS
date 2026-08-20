import '../../../core/platform/agent_channel.dart';
import '../domain/permission_status.dart';

/// Sprint 4's Permission Manager, Dart side — a thin aggregator over
/// AgentPlatformChannel's individual permission methods. Deliberately
/// does not cache results; each call to [checkAll] is a fresh read
/// (same "never trust a stale permission state" instinct as
/// child-agent-lifecycle.md §8's "re-check every cycle, don't assume a
/// one-time grant holds forever").
class PermissionStatusService {
  PermissionStatusService(this._channel);

  final AgentPlatformChannel _channel;

  Future<List<PermissionStatus>> checkAll() async {
    final results = await Future.wait([
      _channel.isUsageAccessGranted(),
      _channel.isAccessibilityServiceEnabled(),
      _channel.hasOverlayPermission(),
      _channel.isBatteryOptimizationExempted(),
      _channel.areNotificationsGranted(),
    ]);

    return [
      PermissionStatus(
        kind: AgentPermissionKind.usageAccess,
        isGranted: results[0],
        label: 'Usage Access',
        labelKey: 'permissions.usageAccess',
      ),
      PermissionStatus(
        kind: AgentPermissionKind.accessibilityService,
        isGranted: results[1],
        label: 'Accessibility Service',
        labelKey: 'permissions.accessibilityService',
      ),
      PermissionStatus(
        kind: AgentPermissionKind.overlay,
        isGranted: results[2],
        label: 'Display Over Other Apps',
        labelKey: 'permissions.overlay',
      ),
      PermissionStatus(
        kind: AgentPermissionKind.batteryOptimization,
        isGranted: results[3],
        label: 'Battery Optimization Exemption',
        labelKey: 'permissions.batteryOptimization',
      ),
      PermissionStatus(
        kind: AgentPermissionKind.notifications,
        isGranted: results[4],
        label: 'Notifications',
        labelKey: 'permissions.notifications',
      ),
    ];
  }

  Future<void> requestPermission(AgentPermissionKind kind) async {
    switch (kind) {
      case AgentPermissionKind.usageAccess:
        await _channel.openUsageAccessSettings();
      case AgentPermissionKind.accessibilityService:
        await _channel.openAccessibilitySettings();
      case AgentPermissionKind.overlay:
        await _channel.requestOverlayPermission();
      case AgentPermissionKind.batteryOptimization:
        await _channel.requestBatteryOptimizationExemption();
      case AgentPermissionKind.notifications:
        // G18. THIS ARM USED TO BE `break`, with a comment saying the OS
        // would ask "when first needed". IT NEVER DID, AND IT NEVER WOULD:
        // POST_NOTIFICATIONS has been declared in the manifest since
        // Sprint 4 and no code path in this app ever requested it, so on
        // Android 13+ every notification the app posted — the
        // foreground-service notification, RuntimeAlertNotifier's alerts,
        // and the whole Smart Notification Engine's output — was silently
        // dropped by the platform.
        //
        // Callers that can use the answer should prefer
        // [requestNotificationPermission] below, which returns it.
        await requestNotificationPermission();
    }
  }

  /// G18 — asks for POST_NOTIFICATIONS and returns WHAT HAPPENED.
  ///
  /// Prefer this over [requestPermission] for notifications: the outcome is the
  /// entire point. A denial the UI cannot see is a denial the child is never
  /// told about, and a PERMANENT denial needs a different response (offer the
  /// settings screen) from a first refusal (accept it and move on).
  ///
  /// THE CALLER MUST HAVE EXPLAINED WHY FIRST. Android shows this dialog at most
  /// twice in the app's whole lifetime, so spending one of those on a child who
  /// has no idea what is being asked wastes a chance that does not come back.
  /// `NotificationPrimingScreen` is that explanation.
  ///
  /// Never throws: a channel failure is reported as
  /// [NotificationPermissionOutcome.denied], because an exception raised while
  /// asking for a permission is strictly worse than a conservative answer.
  Future<NotificationPermissionOutcome> requestNotificationPermission() async {
    try {
      final wire = await _channel.requestNotificationsPermission();
      return NotificationPermissionOutcome.fromWire(wire);
    } catch (_) {
      return NotificationPermissionOutcome.denied;
    }
  }

  /// G18 — opens this app's own notification settings page, the only route left
  /// once Android has stopped showing the runtime dialog. Returns whether a
  /// screen actually opened.
  Future<bool> openNotificationSettings() async {
    try {
      return await _channel.openNotificationSettings();
    } catch (_) {
      return false;
    }
  }
}
