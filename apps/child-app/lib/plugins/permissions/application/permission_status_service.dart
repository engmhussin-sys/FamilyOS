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
        // POST_NOTIFICATIONS is a normal runtime permission (Android 13+)
        // requested via the OS's own permission dialog when first
        // needed (e.g. when the Foreground Service starts, Sprint 4's
        // separately-flagged deferred piece) — not a Settings deep-link
        // like the others. Nothing to do here yet.
        break;
    }
  }
}
