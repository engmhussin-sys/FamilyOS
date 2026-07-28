import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../events/event_bus.dart';
import '../network/api_client.dart';
import '../platform/agent_channel.dart';
import '../platform/agent_channel_impl.dart';
import '../storage/secure_token_storage.dart';

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
