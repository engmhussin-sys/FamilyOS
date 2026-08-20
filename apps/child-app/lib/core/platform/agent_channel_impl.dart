import 'package:flutter/services.dart';

import 'agent_capability_not_implemented_exception.dart';
import 'agent_channel.dart';
import 'agent_channel_constants.dart';

class MethodChannelAgentPlatform implements AgentPlatformChannel {
  MethodChannelAgentPlatform()
      : _channel = const MethodChannel(AgentChannelConstants.channelName);

  final MethodChannel _channel;

  @override
  Future<String> getNativeAppVersion() async {
    return _invoke<String>(AgentChannelConstants.methodGetNativeAppVersion);
  }

  @override
  Future<int> getAndroidSdkInt() async {
    return _invoke<int>(AgentChannelConstants.methodGetAndroidSdkInt);
  }

  @override
  Future<String> getDevicePublicKey() async {
    return _invoke<String>(AgentChannelConstants.methodGetDevicePublicKey);
  }

  // --- Sprint 4: Permission Manager ---

  @override
  Future<bool> isUsageAccessGranted() async {
    return _invoke<bool>(AgentChannelConstants.methodIsUsageAccessGranted);
  }

  @override
  Future<void> openUsageAccessSettings() async {
    await _invokeVoid(AgentChannelConstants.methodOpenUsageAccessSettings);
  }

  @override
  Future<bool> isAccessibilityServiceEnabled() async {
    return _invoke<bool>(AgentChannelConstants.methodIsAccessibilityServiceEnabled);
  }

  @override
  Future<void> openAccessibilitySettings() async {
    await _invokeVoid(AgentChannelConstants.methodOpenAccessibilitySettings);
  }

  @override
  Future<bool> hasOverlayPermission() async {
    return _invoke<bool>(AgentChannelConstants.methodHasOverlayPermission);
  }

  @override
  Future<void> requestOverlayPermission() async {
    await _invokeVoid(AgentChannelConstants.methodRequestOverlayPermission);
  }

  @override
  Future<bool> isBatteryOptimizationExempted() async {
    return _invoke<bool>(AgentChannelConstants.methodIsBatteryOptimizationExempted);
  }

  @override
  Future<void> requestBatteryOptimizationExemption() async {
    await _invokeVoid(AgentChannelConstants.methodRequestBatteryOptimizationExemption);
  }

  @override
  Future<bool> areNotificationsGranted() async {
    return _invoke<bool>(AgentChannelConstants.methodAreNotificationsGranted);
  }

  @override
  Future<String> requestNotificationsPermission() async {
    return _invoke<String>(
      AgentChannelConstants.methodRequestNotificationsPermission,
    );
  }

  @override
  Future<bool> openNotificationSettings() async {
    return _invoke<bool>(AgentChannelConstants.methodOpenNotificationSettings);
  }

  // --- Sprint 4: Device Capability Engine ---

  @override
  Future<Map<Object?, Object?>> getCapabilityReport() async {
    return _invoke<Map<Object?, Object?>>(AgentChannelConstants.methodGetCapabilityReport);
  }

  @override
  Future<List<Object?>> checkTamperSignals() async {
    return _invoke<List<Object?>>(AgentChannelConstants.methodCheckTamperSignals);
  }

  @override
  Future<Map<Object?, Object?>> getRuntimeHealth() async {
    return _invoke<Map<Object?, Object?>>(AgentChannelConstants.methodGetRuntimeHealth);
  }

  @override
  Future<Map<Object?, Object?>> getTodayAppUsageBreakdown() async {
    return _invoke<Map<Object?, Object?>>(AgentChannelConstants.methodGetTodayAppUsageBreakdown);
  }

  @override
  Future<int> getTodayPickupCount() async {
    return _invoke<int>(AgentChannelConstants.methodGetTodayPickupCount);
  }

  // --- Sprint 14 (Behavioral Intelligence Engine) ---

  @override
  Future<Map<Object?, Object?>> getTodayAppCategories() async {
    return _invoke<Map<Object?, Object?>>(AgentChannelConstants.methodGetTodayAppCategories);
  }

  @override
  Future<Map<Object?, Object?>> getTodaySessionStats() async {
    return _invoke<Map<Object?, Object?>>(AgentChannelConstants.methodGetTodaySessionStats);
  }

  // --- Sprint 5: Runtime Enforcement Engine ---

  @override
  Future<void> syncPolicyToNative({
    required int? dailyLimitMinutes,
    required String? bedtimeStart,
    required String? bedtimeEnd,
    required bool focusModeEnabled,
    required List<String> blockedPackages,
  }) async {
    try {
      await _channel.invokeMethod<void>(
        AgentChannelConstants.methodSyncPolicyToNative,
        {
          'dailyLimitMinutes': dailyLimitMinutes,
          'bedtimeStart': bedtimeStart,
          'bedtimeEnd': bedtimeEnd,
          'focusModeEnabled': focusModeEnabled,
          'blockedPackages': blockedPackages,
        },
      );
    } on MissingPluginException {
      throw AgentCapabilityNotImplementedException(AgentChannelConstants.methodSyncPolicyToNative);
    } on PlatformException catch (e) {
      if (e.code == 'NOT_IMPLEMENTED') {
        throw AgentCapabilityNotImplementedException(AgentChannelConstants.methodSyncPolicyToNative);
      }
      rethrow;
    }
  }

  @override
  Future<Map<Object?, Object?>> getEnforcementStatus() async {
    return _invoke<Map<Object?, Object?>>(AgentChannelConstants.methodGetEnforcementStatus);
  }

  @override
  Future<void> startEnforcementService() async {
    await _invokeVoid(AgentChannelConstants.methodStartEnforcementService);
  }

  // --- F2 (audit verdict R7): OEM background-restriction onboarding ---

  @override
  Future<Map<Object?, Object?>> getOemBackgroundRestrictionInfo() async {
    return _invoke<Map<Object?, Object?>>(
      AgentChannelConstants.methodGetOemBackgroundRestrictionInfo,
    );
  }

  @override
  Future<String> openOemBackgroundSettings() async {
    return _invoke<String>(AgentChannelConstants.methodOpenOemBackgroundSettings);
  }

  /// Void-returning calls still go through the same MissingPluginException/
  /// NOT_IMPLEMENTED handling as `_invoke` — factored out since `void`
  /// calls don't have a meaningful generic return type to check for null.
  Future<void> _invokeVoid(String method) async {
    try {
      await _channel.invokeMethod<void>(method);
    } on MissingPluginException {
      throw AgentCapabilityNotImplementedException(method);
    } on PlatformException catch (e) {
      if (e.code == 'NOT_IMPLEMENTED') {
        throw AgentCapabilityNotImplementedException(method);
      }
      rethrow;
    }
  }

  Future<T> _invoke<T>(String method, [Map<String, dynamic>? args]) async {
    try {
      final result = await _channel.invokeMethod<T>(method, args);
      if (result == null) {
        throw StateError('Native method "$method" returned null unexpectedly.');
      }
      return result;
    } on MissingPluginException {
      // Thrown when the native side has no handler registered at all for
      // this channel/method — treated the same as an explicit
      // notImplemented() result (see MainActivity.kt).
      throw AgentCapabilityNotImplementedException(method);
    } on PlatformException catch (e) {
      if (e.code == 'NOT_IMPLEMENTED') {
        throw AgentCapabilityNotImplementedException(method);
      }
      rethrow;
    }
  }
}
