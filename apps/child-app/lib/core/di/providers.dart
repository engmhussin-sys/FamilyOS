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
