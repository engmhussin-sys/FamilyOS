import 'package:flutter_test/flutter_test.dart';

import 'package:child_app/plugins/runtime/application/recovery_coordinator.dart';
import 'package:child_app/plugins/runtime/application/runtime_coordinator.dart';

class _FakeRuntimeCoordinator implements RuntimeCoordinator {
  RuntimeEnforcementStatus status = const RuntimeEnforcementStatus(
    accessibilityServiceEnabled: true,
    hasEverSyncedPolicy: true,
  );
  bool syncPolicyCalled = false;
  bool startEnforcementServiceCalled = false;
  bool shouldThrowOnStart = false;

  @override
  Future<RuntimeEnforcementStatus> getStatus() async => status;

  @override
  Future<void> syncPolicy() async {
    syncPolicyCalled = true;
  }

  @override
  Future<void> startEnforcementService() async {
    startEnforcementServiceCalled = true;
    if (shouldThrowOnStart) throw Exception('failed to start');
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

void main() {
  group('RecoveryCoordinator', () {
    late _FakeRuntimeCoordinator fakeCoordinator;
    late RecoveryCoordinator recovery;

    setUp(() {
      fakeCoordinator = _FakeRuntimeCoordinator();
      recovery = RecoveryCoordinator(fakeCoordinator);
    });

    test('returns notNeeded and does nothing when everything is healthy', () async {
      final outcome = await recovery.attemptRecoveryIfNeeded();

      expect(outcome, RecoveryOutcome.notNeeded);
      expect(fakeCoordinator.syncPolicyCalled, isFalse);
      expect(fakeCoordinator.startEnforcementServiceCalled, isFalse);
    });

    test('re-syncs policy and restarts the service when policy never synced', () async {
      fakeCoordinator.status = const RuntimeEnforcementStatus(
        accessibilityServiceEnabled: true,
        hasEverSyncedPolicy: false,
      );

      final outcome = await recovery.attemptRecoveryIfNeeded();

      expect(outcome, RecoveryOutcome.attempted);
      expect(fakeCoordinator.syncPolicyCalled, isTrue);
      expect(fakeCoordinator.startEnforcementServiceCalled, isTrue);
    });

    test('does NOT attempt to fix a disabled Accessibility Service (no API allows it)', () async {
      fakeCoordinator.status = const RuntimeEnforcementStatus(
        accessibilityServiceEnabled: false,
        hasEverSyncedPolicy: true,
      );

      await recovery.attemptRecoveryIfNeeded();

      // Still restarts the enforcement service (the one thing it CAN
      // do), but never claims to have fixed Accessibility itself.
      expect(fakeCoordinator.startEnforcementServiceCalled, isTrue);
    });

    test('returns failed when the restart attempt throws', () async {
      fakeCoordinator.status = const RuntimeEnforcementStatus(
        accessibilityServiceEnabled: false,
        hasEverSyncedPolicy: true,
      );
      fakeCoordinator.shouldThrowOnStart = true;

      final outcome = await recovery.attemptRecoveryIfNeeded();

      expect(outcome, RecoveryOutcome.failed);
    });
  });
}
