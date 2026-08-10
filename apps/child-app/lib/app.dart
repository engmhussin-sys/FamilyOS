import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'dart:async';

import 'core/di/providers.dart';
import 'core/theme/kid_theme.dart';
import 'features/pairing/presentation/pairing_screen.dart';
import 'features/device_status/presentation/device_home_screen.dart';

/// Sprint 4 update: the paired-state landing screen is now
/// DeviceHomeScreen (permission checklist + capability sync), replacing
/// Step 1's bare platform-channel diagnostic screen — still within the
/// standing "onboarding/diagnostic screens only" scope, since
/// DeviceHomeScreen IS the onboarding/diagnostic screen for a paired
/// device, not a new feature surface.
class ChildAgentApp extends ConsumerWidget {
  const ChildAgentApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return MaterialApp(
      title: 'AI Family Digital Coach — Agent',
      debugShowCheckedModeBanner: false,
      theme: KidTheme.theme,
      home: const _AppRoot(),
    );
  }
}

class _AppRoot extends ConsumerStatefulWidget {
  const _AppRoot();

  @override
  ConsumerState<_AppRoot> createState() => _AppRootState();
}

class _AppRootState extends ConsumerState<_AppRoot> {
  bool? _isPaired;
  Timer? _wellbeingSyncTimer;

  @override
  void initState() {
    super.initState();
    _checkSession();
  }

  @override
  void dispose() {
    _wellbeingSyncTimer?.cancel();
    super.dispose();
  }

  Future<void> _checkSession() async {
    final tokenStorage = ref.read(tokenStorageProvider);
    final hasSession = await tokenStorage.hasSession();
    if (mounted) setState(() => _isPaired = hasSession);
    if (hasSession) {
      ref.read(heartbeatServiceProvider).start();
      await _syncRuntimeAndStartEnforcement();
      _startDigitalWellbeing();
    }
  }

  void _onPaired() {
    setState(() => _isPaired = true);
    ref.read(heartbeatServiceProvider).start();
    _syncRuntimeAndStartEnforcement();
    _startDigitalWellbeing();
  }

  /// Edge-First Intelligence Architecture: starts the near-real-time
  /// critical-event coordinator (which also finally activates
  /// anti-tamper polling — previously built but never started, see
  /// CriticalEventCoordinator's own docstring) and a periodic timer
  /// that builds+queues today's local usage summary and drains
  /// whatever is queued. Every 30 minutes is a deliberate balance:
  /// frequent enough that a day's summary is never far from
  /// up-to-date if the app happens to be foregrounded near a natural
  /// checkpoint, infrequent enough not to matter for battery — this
  /// entire mechanism reads already-aggregated OS data, never
  /// polls anything expensive.
  void _startDigitalWellbeing() {
    ref.read(criticalEventCoordinatorProvider).start();

    _wellbeingSyncTimer?.cancel();
    _wellbeingSyncTimer = Timer.periodic(const Duration(minutes: 30), (_) => _syncWellbeingSummary());
    _syncWellbeingSummary(); // also run once immediately, not just after the first 30-minute tick
  }

  Future<void> _syncWellbeingSummary() async {
    try {
      final service = ref.read(digitalWellbeingServiceProvider);
      // HONEST LIMITATION: pickupCount/nightUsageMinutes/
      // blockedAttemptCount are 0 here — the native pickup-count and
      // night-usage-window computations are NOT yet wired end-to-end
      // (see agent_channel.dart's getTodayPickupCount, implemented
      // natively but not yet cross-referenced against the child's
      // bedtime window here; blockedAttemptCount needs the Policy
      // Enforcement Engine, Track B, not yet built). totalScreenMinutes
      // and the per-app breakdown ARE real. Zero is the honest value
      // for what isn't wired yet, not a fabricated placeholder.
      await service.buildAndQueueDailySummary(
        pickupCount: 0,
        nightUsageMinutes: 0,
        blockedAttemptCount: 0,
      );
      await service.drainOwnEvents();
    } catch (_) {
      // Best-effort — matches every other background sync in this app.
      // Not fatal to the app's core protection function either way.
    }
  }

  Future<void> _syncRuntimeAndStartEnforcement() async {
    final coordinator = ref.read(runtimeCoordinatorProvider);
    try {
      await coordinator.syncPolicy();
    } catch (_) {
      // Sync failure here is non-fatal — NativePolicyStore's
      // DEFAULT_OFFLINE_POLICY (or whatever was last successfully
      // synced) keeps enforcing regardless. The next heartbeat cycle
      // retries naturally.
    }
    try {
      await coordinator.startEnforcementService();
    } catch (_) {
      // Same reasoning — a transient failure here shouldn't crash the
      // paired-state screen; DeviceHomeScreen's permission checklist
      // will surface if Accessibility itself was never enabled.
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_isPaired == null) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    if (_isPaired == false) {
      return PairingScreen(onPaired: _onPaired);
    }
    return const DeviceHomeScreen();
  }
}
