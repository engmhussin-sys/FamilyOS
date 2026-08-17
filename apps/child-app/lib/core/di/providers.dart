import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../events/event_bus.dart';
import '../network/api_client.dart';
import '../platform/agent_channel.dart';
import '../platform/agent_channel_impl.dart';
import '../storage/secure_token_storage.dart';
import '../../features/pairing/api/pairing_api.dart';
import '../../features/pairing/application/device_registration_service.dart';
import '../../features/pairing/application/heartbeat_service.dart';
import '../../features/pairing/application/push_token_registration_service.dart';
import '../../features/device_status/application/capability_reporting_service.dart';
import '../../plugins/permissions/application/permission_status_service.dart';
import '../../plugins/policy/application/policy_cache_service.dart';
import '../../plugins/telemetry/application/runtime_telemetry_collector.dart';
import '../../plugins/runtime/application/runtime_coordinator.dart';
import '../../plugins/runtime/application/recovery_coordinator.dart';
import '../../plugins/offline_queue/application/offline_queue.dart';
import '../../plugins/anti_tamper/contracts/i_anti_tamper.dart';
import '../../plugins/anti_tamper/infrastructure/platform_anti_tamper.dart';
import '../../features/family_growth/api/family_growth_api.dart';
import '../../plugins/screen_time/contracts/i_app_usage_collector.dart';
import '../../plugins/screen_time/infrastructure/platform_app_usage_collector.dart';
import '../../plugins/screen_time/application/digital_wellbeing_service.dart';
import '../../plugins/screen_time/application/critical_event_coordinator.dart';
import '../../features/onboarding/application/onboarding_consent_store.dart';
import '../../features/onboarding/application/oem_background_service.dart';
import '../../features/coach/api/coach_api.dart';
import '../../features/coach/application/coach_controller.dart';
import '../../features/coach/data/coach_repository.dart';
import '../../features/goals/api/achievements_api.dart';
import '../../features/goals/application/goal_session_controller.dart';
import '../../features/goals/application/progress_controller.dart';
import '../../features/goals/application/today_goals_controller.dart';
import '../../features/goals/data/achievements_repository.dart';
import '../../features/goals/domain/child_achievement.dart';
import '../../features/goals/domain/child_goal.dart';
import '../../features/goals/domain/child_rewards.dart';
import '../state/ui_state.dart';

/// Mirrors AuthModule/ChildrenModule/etc.'s provider-binding pattern on
/// the backend: each provider below is the ONE place that knows which
/// concrete implementation satisfies an abstraction. Feature code
/// (Steps 2+) depends on `apiClientProvider` / `agentPlatformChannelProvider`
/// / `eventBusProvider`, never on `Dio`/`MethodChannel`/`StreamController`
/// directly.

/// Single shared instance across the whole Agent — every plugin
/// subscribes to and publishes on THIS bus, which is what makes
/// Decision-017's "no direct module-to-module calls" rule structurally
/// enforceable rather than just a convention (see
/// docs/architecture/child-agent-plugin-architecture.md §2).
final eventBusProvider = Provider<EventBus>((ref) {
  final bus = EventBus();
  ref.onDispose(bus.dispose);
  return bus;
});

final secureStorageProvider = Provider<FlutterSecureStorage>((ref) {
  return const FlutterSecureStorage();
});

final tokenStorageProvider = Provider<SecureTokenStorage>((ref) {
  return SecureTokenStorage(ref.watch(secureStorageProvider));
});

final apiClientProvider = Provider<ApiClient>((ref) {
  return ApiClient(ref.watch(tokenStorageProvider));
});

final agentPlatformChannelProvider = Provider<AgentPlatformChannel>((ref) {
  return MethodChannelAgentPlatform();
});

// --- Sprint 3: Pairing ---

final pairingApiProvider = Provider<PairingApi>((ref) {
  return PairingApi(ref.watch(apiClientProvider));
});

final antiTamperProvider = Provider<IAntiTamper>((ref) {
  return PlatformAntiTamper(ref.watch(agentPlatformChannelProvider));
});

/// The child device's push-token registration — `POST
/// /pairing/device/push-token`, a route that shipped with no consumer.
///
/// DELIBERATELY HAS NO CALLER YET. Token ACQUISITION (FCM) is a separate
/// workstream and this app declares no `firebase_messaging` dependency; when
/// that lands, its `onTokenRefresh` callback calls
/// `ref.read(pushTokenRegistrationServiceProvider).onTokenAvailable(token)`.
/// Nothing here fabricates a token to fill the gap — see the service's own
/// header for the whole boundary.
final pushTokenRegistrationServiceProvider = Provider<PushTokenRegistrationService>((ref) {
  return PushTokenRegistrationService(
    ref.watch(pairingApiProvider),
    ref.watch(secureStorageProvider),
  );
});

final deviceRegistrationServiceProvider = Provider<DeviceRegistrationService>((ref) {
  return DeviceRegistrationService(
    ref.watch(pairingApiProvider),
    ref.watch(agentPlatformChannelProvider),
    ref.watch(tokenStorageProvider),
    ref.watch(antiTamperProvider),
  );
});

// --- Sprint 5: Runtime Enforcement Engine ---

final runtimeCoordinatorProvider = Provider<RuntimeCoordinator>((ref) {
  return RuntimeCoordinator(
    ref.watch(agentPlatformChannelProvider),
    ref.watch(pairingApiProvider),
    ref.watch(policyCacheServiceProvider),
  );
});

final recoveryCoordinatorProvider = Provider<RecoveryCoordinator>((ref) {
  return RecoveryCoordinator(ref.watch(runtimeCoordinatorProvider));
});

final offlineQueueProvider = Provider<OfflineQueue>((ref) {
  return OfflineQueue(ref.watch(secureStorageProvider));
});

final heartbeatServiceProvider = Provider<HeartbeatService>((ref) {
  final service = HeartbeatService(
    ref.watch(pairingApiProvider),
    telemetryProvider: () => ref.read(runtimeCoordinatorProvider).collectTelemetryFields(),
    offlineQueue: ref.watch(offlineQueueProvider),
  );
  ref.onDispose(service.stop);
  return service;
});

// --- Sprint 4: Permissions + Capabilities ---

final permissionStatusServiceProvider = Provider<PermissionStatusService>((ref) {
  return PermissionStatusService(ref.watch(agentPlatformChannelProvider));
});

final capabilityReportingServiceProvider = Provider<CapabilityReportingService>((ref) {
  return CapabilityReportingService(
    ref.watch(agentPlatformChannelProvider),
    ref.watch(pairingApiProvider),
  );
});

// --- Child Runtime Engine: Policy Cache + Telemetry ---

/// Was built (previous session) but never actually wired into DI —
/// closed now, alongside the telemetry collector that depends on it.
final policyCacheServiceProvider = Provider<PolicyCacheService>((ref) {
  return PolicyCacheService(ref.watch(secureStorageProvider));
});

final runtimeTelemetryCollectorProvider = Provider<RuntimeTelemetryCollector>((ref) {
  return RuntimeTelemetryCollector(
    ref.watch(agentPlatformChannelProvider),
    ref.watch(policyCacheServiceProvider),
    ref.watch(heartbeatServiceProvider),
  );
});

// --- Sprint 29: Life Intelligence Platform, child-facing self-service ---

final familyGrowthApiProvider = Provider<FamilyGrowthApi>((ref) {
  return FamilyGrowthApi(ref.watch(apiClientProvider));
});

// --- Edge-First Intelligence Architecture: Digital Wellbeing ---

final appUsageCollectorProvider = Provider<IAppUsageCollector>((ref) {
  return PlatformAppUsageCollector(ref.watch(agentPlatformChannelProvider));
});

/// A GENUINELY SEPARATE queue instance from `offlineQueueProvider`
/// above (own storage key: 'wellbeing_offline_queue' vs Heartbeat's
/// 'cre_offline_queue' default) — found and fixed during design:
/// sharing the same instance would have caused HeartbeatService's own
/// drain() to throw and stop prematurely the moment it encountered a
/// wellbeing-typed event, and vice versa. Same OfflineQueue class/
/// mechanism reused exactly as instructed, isolated by key rather
/// than by a second implementation.
final wellbeingOfflineQueueProvider = Provider<OfflineQueue>((ref) {
  return OfflineQueue(ref.watch(secureStorageProvider), storageKey: 'wellbeing_offline_queue');
});

final digitalWellbeingServiceProvider = Provider<DigitalWellbeingService>((ref) {
  return DigitalWellbeingService(
    ref.watch(appUsageCollectorProvider),
    ref.watch(apiClientProvider),
    ref.watch(wellbeingOfflineQueueProvider),
    ref.watch(agentPlatformChannelProvider),
  );
});

final criticalEventCoordinatorProvider = Provider<CriticalEventCoordinator>((ref) {
  final coordinator = CriticalEventCoordinator(
    ref.watch(antiTamperProvider) as PlatformAntiTamper,
    ref.watch(digitalWellbeingServiceProvider),
  );
  ref.onDispose(coordinator.dispose);
  return coordinator;
});

// --- F2: onboarding (Play prominent disclosure + OEM survival) ---

/// Local record that the first-run disclosure was shown and acknowledged
/// on THIS device (audit A3 §4/P2, verdict risk R5). Not the backend's
/// ParentalConsent record — see the store's own docstring.
final onboardingConsentStoreProvider = Provider<OnboardingConsentStore>((ref) {
  return const SharedPreferencesOnboardingConsentStore();
});

/// Typed wrapper over the native OEM autostart/battery deep links
/// (verdict risk R7). Reuses the single agentPlatformChannelProvider like
/// every other native-facing service here.
final oemBackgroundServiceProvider = Provider<OemBackgroundService>((ref) {
  return OemBackgroundService(ref.watch(agentPlatformChannelProvider));
});

// ---------------------------------------------------------------------------
// B7 — THE F4 CHILD SURFACE (Smart Learning & Reward)
//
// Six endpoints, all previously unconsumed (audit PA-M-001, ⛔ Critical).
// Wired onto the EXISTING `apiClientProvider`: same device-token auth, same
// coordinated single refresh on 401, same B3 error-envelope parsing. No
// second HTTP client exists in this app and none was added.
// ---------------------------------------------------------------------------

final childAchievementsApiProvider = Provider<ChildAchievementsApi>((ref) {
  return ChildAchievementsApi(ref.watch(apiClientProvider));
});

final childAchievementsRepositoryProvider = Provider<ChildAchievementsRepository>((ref) {
  return ChildAchievementsRepository(ref.watch(childAchievementsApiProvider));
});

/// Today's goals — the child's first screen.
final todayGoalsControllerProvider =
    StateNotifierProvider<TodayGoalsController, UiState<List<TodayGoal>>>((ref) {
  return TodayGoalsController(ref.watch(childAchievementsRepositoryProvider));
});

final myAttemptsControllerProvider =
    StateNotifierProvider.autoDispose<MyAttemptsController, UiState<List<MyAttempt>>>((ref) {
  return MyAttemptsController(ref.watch(childAchievementsRepositoryProvider));
});

/// ONE SESSION PER GOAL, keyed by the goal itself.
///
/// `autoDispose` is deliberate and load-bearing here: it is what stops a
/// `ForegroundStopwatch` (and its 1-second `Timer`) from outliving the
/// screen that owns it. `GoalSessionController.dispose` cancels the ticker
/// and detaches the `WidgetsBindingObserver`.
final goalSessionControllerProvider = StateNotifierProvider.autoDispose
    .family<GoalSessionController, GoalSessionState, TodayGoal>((ref, goal) {
  return GoalSessionController(ref.watch(childAchievementsRepositoryProvider), goal);
});

final progressControllerProvider =
    StateNotifierProvider<ProgressController, UiState<ProgressSnapshot>>((ref) {
  return ProgressController(ref.watch(childAchievementsRepositoryProvider));
});

final childRewardsControllerProvider =
    StateNotifierProvider<ChildRewardsController, UiState<ChildRewardsSnapshot>>((ref) {
  return ChildRewardsController(ref.watch(childAchievementsRepositoryProvider));
});

// ---------------------------------------------------------------------------
// THE CHILD'S COACH — `/self/coach/*`
//
// Four routes that shipped complete and had ZERO Flutter consumers: today's
// encouragement, the nine-question closed vocabulary, the per-code answer,
// and the check-in safety path. Child MVP capability 13 was a backend that
// nothing called. Wired onto the EXISTING `apiClientProvider` — same
// device-token auth, same coordinated refresh on 401, same B3 error-envelope
// parsing. No second HTTP client was added.
// ---------------------------------------------------------------------------

final childCoachApiProvider = Provider<ChildCoachApi>((ref) {
  return ChildCoachApi(ref.watch(apiClientProvider));
});

final childCoachRepositoryProvider = Provider<ChildCoachRepository>((ref) {
  return ChildCoachRepository(ref.watch(childCoachApiProvider));
});

/// DELIBERATELY NOT `autoDispose`. Once a child has read today's card and
/// opened a question, switching tabs and coming back should not re-hit a
/// throttled endpoint, and should not silently discard the answer they were
/// part-way through reading.
final coachControllerProvider = StateNotifierProvider<CoachController, CoachState>((ref) {
  return CoachController(ref.watch(childCoachRepositoryProvider));
});
