import '../../runtime/application/runtime_coordinator.dart';

enum RecoveryOutcome { notNeeded, attempted, failed }

/// Sprint 7's "Recovery Coordinator." Dart-side orchestration only \u2014
/// same CRE principle as `RuntimeCoordinator`: this class decides WHEN
/// to attempt recovery (based on status it reads), never WHAT the
/// policy should be. The actual retry logic for the native
/// Foreground Service already exists natively
/// (`RuntimeWatchdogWorker.kt`, Sprint 6) \u2014 this class's job is the
/// one thing that watchdog can't do on its own: re-push the policy
/// (which requires the backend call `RuntimeCoordinator.syncPolicy`
/// already owns) and restart the enforcement service from the Dart
/// side, for the case where the app IS running (foreground/background)
/// but something looks wrong \u2014 the native watchdog's 15-minute
/// WorkManager cycle is a slower, independent backstop for when it isn't.
class RecoveryCoordinator {
  RecoveryCoordinator(this._runtimeCoordinator);

  final RuntimeCoordinator _runtimeCoordinator;

  /// Checks current enforcement status and, if protection looks
  /// unhealthy, attempts the two things this app CAN do from Dart:
  /// re-sync the policy and re-request the enforcement service start.
  /// Does NOT attempt to fix Accessibility being disabled \u2014 no API
  /// allows that; the permission checklist UI (already built,
  /// `DeviceHomeScreen`) is the correct path for that specific problem.
  Future<RecoveryOutcome> attemptRecoveryIfNeeded() async {
    final status = await _runtimeCoordinator.getStatus();

    if (status.accessibilityServiceEnabled && status.hasEverSyncedPolicy) {
      return RecoveryOutcome.notNeeded;
    }

    try {
      if (!status.hasEverSyncedPolicy) {
        await _runtimeCoordinator.syncPolicy();
      }
      await _runtimeCoordinator.startEnforcementService();
      return RecoveryOutcome.attempted;
    } catch (_) {
      return RecoveryOutcome.failed;
    }
  }
}
