import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design_system/design_system.dart';
import '../../../core/di/providers.dart';
import '../../../core/localization/locale_controller.dart';
import '../../../plugins/permissions/domain/permission_status.dart';
import '../../../plugins/runtime/application/runtime_coordinator.dart';
import '../../../plugins/telemetry/contracts/runtime_telemetry.dart';
import '../../family_growth/presentation/my_growth_screen.dart';
import '../../family_growth/presentation/rewards_screen.dart';
import '../../onboarding/presentation/accessibility_priming_screen.dart';
import '../../onboarding/presentation/notification_priming_screen.dart';
import '../../onboarding/presentation/oem_setup_screen.dart';

/// Combines Sprint 4's three Flutter requirements ("Permission
/// onboarding," "Child status," "Device health") into ONE screen rather
/// than three separate ones — still within the standing
/// "onboarding/diagnostic screens only" constraint, since all three are
/// facets of the same "is this device correctly set up" question, not
/// three distinct product features.
class DeviceHomeScreen extends ConsumerStatefulWidget {
  const DeviceHomeScreen({super.key});

  @override
  ConsumerState<DeviceHomeScreen> createState() => _DeviceHomeScreenState();
}

class _DeviceHomeScreenState extends ConsumerState<DeviceHomeScreen> with WidgetsBindingObserver {
  List<PermissionStatus> _permissions = [];
  bool _isLoadingPermissions = true;
  bool _isSyncingCapabilities = false;
  String? _syncMessage;
  RuntimeEnforcementStatus? _enforcementStatus;
  RuntimeTelemetrySnapshot? _telemetry;
  int _queuedEventCount = 0;

  /// F2 (verdict risk R7): the OEM autostart step is offered ONCE,
  /// automatically, and only on a device that needs it. Guarded by this
  /// flag as well as by the persisted store so a resume from Settings —
  /// which re-runs didChangeAppLifecycleState — cannot push the screen a
  /// second time on top of itself.
  bool _oemStepEvaluated = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _refreshPermissions();
    _refreshEnforcementStatus();
    _refreshDiagnostics();
    _maybeOfferOemStep();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // Re-check permissions whenever the app resumes — the user likely
    // just came back from a Settings screen. Matches lifecycle ADR §8's
    // "re-check every cycle, don't assume a one-time grant holds" principle.
    if (state == AppLifecycleState.resumed) {
      ref.read(recoveryCoordinatorProvider).attemptRecoveryIfNeeded();
      _refreshPermissions();
      _refreshEnforcementStatus();
      _refreshDiagnostics();
    }
  }

  /// F2 (verdict risk R7). Shows the OEM autostart step exactly once per
  /// install, and only when the device is one of the skins that kills
  /// background services outside AOSP rules, or when the battery
  /// exemption is missing. Every failure path here is swallowed: this is
  /// a helpful extra step, and it must never be able to stop the status
  /// screen from rendering.
  Future<void> _maybeOfferOemStep() async {
    if (_oemStepEvaluated) return;
    _oemStepEvaluated = true;
    try {
      final store = ref.read(onboardingConsentStoreProvider);
      if (await store.hasCompletedOemStep()) return;
      final info = await ref.read(oemBackgroundServiceProvider).load();
      if (!info.needsAttention) return;
      if (!mounted) return;
      await OemSetupScreen.show(context);
    } catch (_) {
      // Best-effort, like every other optional path on this screen.
    }
  }

  /// F2 (Play policy, verdict risk R5). The permission checklist used to
  /// deep-link straight into the system Accessibility screen. Every route
  /// to that screen now passes through the priming interstitial first,
  /// which is both the policy requirement and the honest thing to do for
  /// the most powerful permission on the platform.
  ///
  /// Declining is a no-op — no nagging, no repeat prompt, no "you must".
  Future<void> _requestPermission(PermissionStatus status) async {
    if (status.kind == AgentPermissionKind.accessibilityService) {
      final proceed = await AccessibilityPrimingScreen.show(context);
      if (!proceed) return;
    }

    // G18. Notifications are the one permission on this list that is a NORMAL
    // runtime permission: Android shows its own dialog instead of a Settings
    // screen, and it shows it at most twice in the app's lifetime. So this arm
    // is handled separately — explain, then ask, then respond to the ANSWER,
    // which the fire-and-forget path below cannot see.
    if (status.kind == AgentPermissionKind.notifications) {
      await _requestNotificationPermission();
      return;
    }

    await ref.read(permissionStatusServiceProvider).requestPermission(status.kind);
  }

  /// G18 — the explained ask, and the graceful denial.
  ///
  /// Declining is a NON-EVENT by design: the child is told plainly that
  /// everything else still works, and nothing nags them afterwards. That is
  /// CONTEXT §3.7 (non-punitive) applied to a permission prompt — the same
  /// instinct as the accessibility path's "declining is a no-op".
  ///
  /// A PERMANENT denial is the one case needing more than a message, because
  /// the row the child just tapped can never work again: Android will not show
  /// the dialog, so the settings screen is offered rather than leaving a control
  /// that silently does nothing.
  Future<void> _requestNotificationPermission() async {
    final proceed = await NotificationPrimingScreen.show(context);
    if (!proceed) return;

    final service = ref.read(permissionStatusServiceProvider);
    final outcome = await service.requestNotificationPermission();
    if (!mounted) return;

    final t = ref.read(localeControllerProvider.notifier).t;

    switch (outcome) {
      case NotificationPermissionOutcome.granted:
      case NotificationPermissionOutcome.alreadyGranted:
      case NotificationPermissionOutcome.notRequired:
        _showSnack(t('notifPriming.granted'));
      case NotificationPermissionOutcome.denied:
        _showSnack(t('notifPriming.denied'));
      case NotificationPermissionOutcome.permanentlyDenied:
        _showSnack(
          t('notifPriming.permanentlyDenied'),
          action: SnackBarAction(
            label: t('notifPriming.openSettings'),
            onPressed: () => service.openNotificationSettings(),
          ),
        );
    }

    // The checklist must reflect the new state immediately: on this path there
    // is no Settings round trip, so didChangeAppLifecycleState never fires.
    await _refreshPermissions();
  }

  void _showSnack(String message, {SnackBarAction? action}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(message),
        action: action,
        duration:
            action == null ? const Duration(seconds: 4) : const Duration(seconds: 8),
      ),
    );
  }

  /// Sprint 7's Runtime Diagnostics UI — surfaces
  /// RuntimeTelemetryCollector's snapshot (memory/battery/health) and
  /// the Offline Queue's current backlog, both already built (Sprint 4
  /// §9 and Sprint 7's OfflineQueue) but never previously shown anywhere.
  Future<void> _refreshDiagnostics() async {
    try {
      final telemetry = await ref.read(runtimeTelemetryCollectorProvider).collect();
      final queueLength = await ref.read(offlineQueueProvider).length();
      if (mounted) {
        setState(() {
          _telemetry = telemetry;
          _queuedEventCount = queueLength;
        });
      }
    } catch (_) {
      // Diagnostics are supplementary — a failure here shouldn't crash
      // the rest of the status screen.
    }
  }

  Future<void> _refreshEnforcementStatus() async {
    try {
      final status = await ref.read(runtimeCoordinatorProvider).getStatus();
      if (mounted) setState(() => _enforcementStatus = status);
    } catch (_) {
      // Leave _enforcementStatus as-is (null or last known) — a
      // read failure here shouldn't crash the whole status screen.
    }
  }

  Future<void> _refreshPermissions() async {
    setState(() => _isLoadingPermissions = true);
    final service = ref.read(permissionStatusServiceProvider);
    final results = await service.checkAll();
    if (mounted) {
      setState(() {
        _permissions = results;
        _isLoadingPermissions = false;
      });
    }
  }

  Future<void> _syncCapabilities() async {
    setState(() {
      _isSyncingCapabilities = true;
      _syncMessage = null;
    });
    try {
      await ref.read(capabilityReportingServiceProvider).reportNow();
      if (mounted) setState(() => _syncMessage = ref.read(localeControllerProvider.notifier).t('deviceStatus.syncSuccess'));
    } catch (_) {
      if (mounted) setState(() => _syncMessage = ref.read(localeControllerProvider.notifier).t('deviceStatus.syncFailed'));
    } finally {
      if (mounted) setState(() => _isSyncingCapabilities = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    ref.watch(localeControllerProvider);
    final localeController = ref.watch(localeControllerProvider.notifier);
    final t = localeController.t;

    return Directionality(
      textDirection: localeController.isRtl ? TextDirection.rtl : TextDirection.ltr,
      child: Scaffold(
        appBar: AppBar(title: Text(t('deviceStatus.title'))),
        body: RefreshIndicator(
          onRefresh: _refreshPermissions,
          child: ListView(
            padding: const EdgeInsets.all(KidSpace.lg),
            children: [
              Text(
                t('deviceStatus.pairedHeartbeat'),
                style: KidText.cardTitle(context),
              ),
              const SizedBox(height: KidSpace.lg),
              FilledButton.icon(
                onPressed: () => Navigator.of(context).push(
                  MaterialPageRoute(builder: (_) => const MyGrowthScreen()),
                ),
                icon: const Icon(Icons.emoji_events_outlined),
                label: Text(t('deviceStatus.myGrowth')),
              ),
              const SizedBox(height: KidSpace.md),
              FilledButton.icon(
                onPressed: () => Navigator.of(context).push(
                  MaterialPageRoute(builder: (_) => const RewardsScreen()),
                ),
                icon: const Icon(Icons.card_giftcard_rounded),
                label: Text(t('deviceStatus.myRewards')),
              ),
              const SizedBox(height: KidSpace.lg),
              Text(t('deviceStatus.runtimeStatus'), style: KidText.cardTitle(context)),
              const SizedBox(height: KidSpace.sm),
              _buildEnforcementStatusTile(t),
              const SizedBox(height: KidSpace.sm),
              // Always reachable, not only on first run: the OEM setting
              // is the one a factory reset, a system update or a
              // "battery saver" sweep silently undoes.
              OutlinedButton.icon(
                onPressed: () => OemSetupScreen.show(context),
                icon: const Icon(Icons.battery_saver_outlined),
                label: Text(t('oem.title')),
              ),
              const SizedBox(height: KidSpace.lg),
              Text(t('deviceStatus.diagnostics'), style: KidText.cardTitle(context)),
              const SizedBox(height: KidSpace.sm),
              _buildDiagnosticsTile(t),
              const SizedBox(height: KidSpace.lg),
              Text(t('deviceStatus.permissions'), style: KidText.cardTitle(context)),
              const SizedBox(height: KidSpace.sm),
              if (_isLoadingPermissions)
                const Center(child: CircularProgressIndicator())
              else
                ..._permissions.map((p) => _buildPermissionTile(p, t)),
              const SizedBox(height: KidSpace.xl),
              Text(t('deviceStatus.capabilities'), style: KidText.cardTitle(context)),
              const SizedBox(height: KidSpace.sm),
              ElevatedButton(
                onPressed: _isSyncingCapabilities ? null : _syncCapabilities,
                child: _isSyncingCapabilities
                    ? const SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : Text(t('deviceStatus.syncCapabilities')),
              ),
              if (_syncMessage != null) ...[
                const SizedBox(height: KidSpace.sm),
                Text(_syncMessage!),
              ],
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildEnforcementStatusTile(String Function(String, {int? count, Map<String, Object>? options}) t) {
    final status = _enforcementStatus;
    if (status == null) {
      return Text(t('common.checking'), style: KidText.caption(context).copyWith(color: KidColor.unknown));
    }
    final isActive = status.accessibilityServiceEnabled && status.hasEverSyncedPolicy;
    return ListTile(
      leading: Icon(
        isActive ? Icons.shield : Icons.shield_outlined,
        color: isActive ? KidColor.done : KidColor.notNow,
      ),
      title: Text(isActive ? t('deviceStatus.protectionActive') : t('deviceStatus.protectionNotActive')),
      subtitle: Text(
        !status.accessibilityServiceEnabled
            ? t('deviceStatus.accessibilityOff')
            : !status.hasEverSyncedPolicy
                ? t('deviceStatus.noPolicySynced')
                : t('deviceStatus.enforcingPolicy'),
      ),
    );
  }

  Widget _buildDiagnosticsTile(String Function(String, {int? count, Map<String, Object>? options}) t) {
    final telemetry = _telemetry;
    if (telemetry == null) {
      return Text(t('common.checking'), style: KidText.caption(context).copyWith(color: KidColor.unknown));
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(t('deviceStatus.memoryUsage', options: {'mb': telemetry.memoryUsageMb})),
        Text(t('deviceStatus.battery', options: {'percent': telemetry.batteryPercent ?? t('deviceStatus.batteryUnknown')})),
        Text(t('deviceStatus.healthLabel', options: {'status': telemetry.isHealthy ? t('deviceStatus.healthNormal') : t('deviceStatus.healthAttention')})),
        if (telemetry.warnings.isNotEmpty)
          Text(
            telemetry.warnings.join(', '),
            style: KidText.caption(context).copyWith(color: KidColor.notNow),
          ),
        if (_queuedEventCount > 0)
          Padding(
            padding: const EdgeInsets.only(top: KidSpace.xs),
            child: Text(
              t('deviceStatus.queuedUpdates', options: {'count': _queuedEventCount}),
              style: KidText.caption(context).copyWith(color: KidColor.notNow),
            ),
          ),
      ],
    );
  }

  Widget _buildPermissionTile(PermissionStatus status, String Function(String, {int? count, Map<String, Object>? options}) t) {
    return ListTile(
      leading: Icon(
        status.isGranted ? Icons.check_circle : Icons.warning_amber_rounded,
        color: status.isGranted ? KidColor.done : KidColor.notNow,
      ),
      title: Text(t(status.labelKey)),
      trailing: status.isGranted
          ? null
          : TextButton(
              onPressed: () => _requestPermission(status),
              child: Text(t('deviceStatus.fix')),
            ),
    );
  }
}
