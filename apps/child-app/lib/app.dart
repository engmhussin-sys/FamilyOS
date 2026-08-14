import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'dart:async';

import 'core/di/providers.dart';
import 'core/localization/locale_controller.dart';
import 'core/theme/kid_theme.dart';
import 'features/pairing/presentation/pairing_screen.dart';
import 'features/device_status/presentation/device_home_screen.dart';
import 'features/onboarding/presentation/prominent_disclosure_screen.dart';

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
    // Watch the STATE (not just `.notifier`) so a language change actually
    // rebuilds — see LocaleController's docstring for why this line is
    // load-bearing despite its return value being unused.
    ref.watch(localeControllerProvider);
    final localeController = ref.watch(localeControllerProvider.notifier);

    return MaterialApp(
      title: 'AI Family Digital Coach — Agent',
      debugShowCheckedModeBanner: false,
      theme: KidTheme.theme,
      // CLOSES audit MA-017: this app previously set no locale at all, so
      // every native Material widget (date pickers, dialog button labels,
      // text-selection handles) stayed English/LTR even when the child's
      // own screens were Arabic. Copied verbatim from parent-app's
      // main.dart, which already had this right.
      locale: localeController.toLocale,
      localizationsDelegates: const [
        GlobalMaterialLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
      ],
      supportedLocales: const [Locale('ar'), Locale('en')],
      // Directionality belongs HERE, on MaterialApp's builder, not on each
      // screen individually (audit §6 gap 6): anything rendered into the
      // root Overlay — showDialog, SnackBar, CelebrationOverlay — is built
      // OUTSIDE the per-screen widget tree and so escaped the per-screen
      // Directionality wrappers, rendering LTR in an Arabic app.
      builder: (context, child) => Directionality(
        textDirection: localeController.isRtl ? TextDirection.rtl : TextDirection.ltr,
        child: child!,
      ),
      home: const _AppRoot(),
    );
  }
}

class _AppRoot extends ConsumerStatefulWidget {
  const _AppRoot();

  @override
  ConsumerState<_AppRoot> createState() => _AppRootState();
}

class _AppRootState extends ConsumerState<_AppRoot> with WidgetsBindingObserver {
  bool? _isPaired;

  /// F2 (Play User Data policy; audit A3 §4/P2, verdict risk R5).
  /// `null` = not read yet, `false` = disclosure must be shown FIRST.
  ///
  /// This gate sits ABOVE pairing on purpose. Pairing is the first thing
  /// that talks to the backend, so putting the disclosure after it would
  /// mean data left the device before the family was told what leaves the
  /// device — which is the exact ordering the policy forbids.
  bool? _hasAcknowledgedDisclosure;
  Timer? _wellbeingSafetyTimer;

  // FIXES A REAL COST GAP (Sprint 14.2): threshold state, checked
  // locally (zero network cost) before deciding whether a real sync
  // (which uploads) is actually warranted.
  int? _lastSyncedScreenMinutes;
  DateTime? _lastSyncDate;

  // 15 minutes of NEW screen time since the last successful sync is
  // the threshold — meaningful enough to be worth a fresh snapshot
  // (roughly one real usage session, per SessionAnalyzer's own
  // fragmentation-detection assumptions), not so tight that ordinary
  // fluctuation triggers constant syncing.
  static const _screenMinutesThreshold = 15;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _checkSession();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _wellbeingSafetyTimer?.cancel();
    super.dispose();
  }

  /// FIXES A REAL COST GAP (Sprint 14.2): the app backgrounding is a
  /// REAL EVENT (the child locked the screen, switched apps, or the
  /// OS is reclaiming resources) — the single most meaningful moment
  /// to persist the day's latest usage, since there's no guarantee
  /// the app will be foregrounded again soon. Threshold-checked like
  /// every other trigger here, not an unconditional sync.
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.paused && _isPaired == true) {
      _syncWellbeingSummaryIfThresholdMet();
    }
  }

  Future<void> _checkSession() async {
    // Disclosure first, session second — see _hasAcknowledgedDisclosure.
    try {
      final acknowledged =
          await ref.read(onboardingConsentStoreProvider).hasAcknowledgedDisclosure();
      if (mounted) setState(() => _hasAcknowledgedDisclosure = acknowledged);
    } catch (_) {
      // A preferences read failure must fail SAFE, i.e. towards showing
      // the disclosure again, never towards skipping it.
      if (mounted) setState(() => _hasAcknowledgedDisclosure = false);
    }

    final tokenStorage = ref.read(tokenStorageProvider);
    final hasSession = await tokenStorage.hasSession();
    if (mounted) setState(() => _isPaired = hasSession);
    // The heartbeat and the wellbeing sync are the two things that MOVE
    // DATA OFF THE DEVICE. Neither may start before the disclosure has
    // been acknowledged — including on an EXISTING paired install that is
    // upgrading into this build, which is the case a naive gate at the
    // widget level would have missed entirely: the widget would show the
    // disclosure while the services quietly uploaded behind it.
    if (hasSession && _hasAcknowledgedDisclosure == true) {
      await _startSessionServices();
    }
  }

  /// Everything that begins network activity for a paired device. Split
  /// out so it has exactly two callers, both of which are gated on the
  /// disclosure: [_checkSession] and [_onDisclosureAccepted].
  Future<void> _startSessionServices() async {
    ref.read(heartbeatServiceProvider).start();
    await _syncRuntimeAndStartEnforcement();
    _startDigitalWellbeing();
  }

  void _onDisclosureAccepted() {
    setState(() => _hasAcknowledgedDisclosure = true);
    // An already-paired device that was waiting on the disclosure starts
    // its services now, not on the next cold start.
    if (_isPaired == true) _startSessionServices();
  }

  void _onPaired() {
    setState(() => _isPaired = true);
    _startSessionServices();
  }

  /// FIXES A REAL COST GAP (Sprint 14.2 — previously found in Sprint
  /// 14.1's own integration audit): the fixed 30-minute
  /// Timer.periodic could produce up to ~48 uploads/device/day even
  /// though the underlying data barely changed between most of them
  /// (upsert-idempotent, but still a real, unnecessary request each
  /// time). Replaced with:
  ///   1. THRESHOLD-DRIVEN checks (real usage must have grown by
  ///      _screenMinutesThreshold minutes since the last successful
  ///      sync) — checked via a LOCAL-ONLY call (IAppUsageCollector,
  ///      already-aggregated by Android, zero network cost to check).
  ///   2. A real EVENT trigger — app backgrounding
  ///      (didChangeAppLifecycleState above).
  ///   3. A much-longer PERIODIC SAFETY NET (4 hours, not 30 minutes)
  ///      — guarantees data is never more than 4 hours stale even on
  ///      a device that's foregrounded continuously without crossing
  ///      the threshold (e.g. idle in a single long-running app) or
  ///      never backgrounded.
  /// Anomaly detection is unaffected: the backend's own detection
  /// pipeline runs once per day's upload (see
  /// DigitalWellbeingEngineService.recordDailySummary), not per sync
  /// call — fewer, well-timed uploads of the SAME eventual daily
  /// total change nothing about what patterns get detected.
  void _startDigitalWellbeing() {
    ref.read(criticalEventCoordinatorProvider).start();

    _wellbeingSafetyTimer?.cancel();
    _wellbeingSafetyTimer = Timer.periodic(const Duration(hours: 4), (_) => _syncWellbeingSummary(force: true));
    _syncWellbeingSummary(force: true); // always sync once on startup — establishes the baseline for future threshold checks
  }

  /// Cheap, LOCAL-ONLY check (no network call) — reads Android's
  /// already-aggregated usage stats, compares against the last
  /// successfully synced value, and only proceeds to the real
  /// (network-touching) sync if the threshold is met OR the local
  /// calendar day has changed since the last sync (a day boundary
  /// crossing must always sync the outgoing day's final totals,
  /// regardless of how small the last delta was — otherwise a few
  /// minutes of end-of-day usage could be silently lost from that
  /// day's snapshot).
  Future<void> _syncWellbeingSummaryIfThresholdMet() async {
    try {
      final usage = await ref.read(appUsageCollectorProvider).getTodayUsage();
      final currentMinutes = usage.values.fold<int>(0, (sum, d) => sum + d.inMinutes);
      final today = DateTime.now();
      final dayChanged = _lastSyncDate == null ||
          _lastSyncDate!.year != today.year ||
          _lastSyncDate!.month != today.month ||
          _lastSyncDate!.day != today.day;

      final delta = _lastSyncedScreenMinutes == null ? _screenMinutesThreshold : currentMinutes - _lastSyncedScreenMinutes!;
      if (dayChanged || delta >= _screenMinutesThreshold) {
        await _syncWellbeingSummary(force: false);
      }
    } catch (_) {
      // Best-effort — the periodic safety net (4h) or the next
      // real event still covers this device if this particular
      // threshold check fails for any reason.
    }
  }

  Future<void> _syncWellbeingSummary({required bool force}) async {
    try {
      final service = ref.read(digitalWellbeingServiceProvider);
      // FIXED (Sprint 14.1 integration audit): pickupCount and
      // nightUsageMinutes are now computed inside
      // DigitalWellbeingService itself from real device data — see
      // that method's own docstring for the bug this closes.
      // blockedAttemptCount still needs the Policy Enforcement Engine
      // (Track B, not yet built) — that remains a real, separate,
      // documented architectural gap, not something this fix touches.
      await service.buildAndQueueDailySummary(blockedAttemptCount: 0);
      await service.drainOwnEvents();

      // Update threshold-tracking state only after a successful
      // upload attempt (queue+drain) — an exception above skips this,
      // so a failed sync correctly leaves the OLD baseline in place
      // for the next threshold check, not a falsely-advanced one.
      final usage = await ref.read(appUsageCollectorProvider).getTodayUsage();
      _lastSyncedScreenMinutes = usage.values.fold<int>(0, (sum, d) => sum + d.inMinutes);
      _lastSyncDate = DateTime.now();
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
    if (_isPaired == null || _hasAcknowledgedDisclosure == null) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    if (_hasAcknowledgedDisclosure == false) {
      return ProminentDisclosureScreen(onAccepted: _onDisclosureAccepted);
    }
    if (_isPaired == false) {
      return PairingScreen(onPaired: _onPaired);
    }
    return const DeviceHomeScreen();
  }
}
