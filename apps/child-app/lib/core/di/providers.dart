import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../network/api_client.dart';
import '../platform/agent_channel.dart';
import '../platform/agent_channel_impl.dart';
import '../storage/secure_token_storage.dart';

/// Mirrors AuthModule/ChildrenModule/etc.'s provider-binding pattern on
/// the backend: each provider below is the ONE place that knows which
/// concrete implementation satisfies an abstraction. Feature code
/// (Steps 2+) depends on `apiClientProvider` / `agentPlatformChannelProvider`,
/// never on `Dio`/`MethodChannel` directly.

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
