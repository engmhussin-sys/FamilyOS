/// The MethodChannel name and method identifiers shared between
/// lib/core/platform/agent_channel_impl.dart and
/// android/.../MainActivity.kt. Keeping these as named constants (instead
/// of inline string literals on both sides) is what prevents a silent
/// typo from becoming a runtime "method not found" bug that only shows up
/// on a real device.
class AgentChannelConstants {
  const AgentChannelConstants._();

  static const String channelName = 'com.aifamilycoach.child_app/agent';

  // --- Methods implemented as of Step 1 (Core Architecture) ---
  static const String methodGetNativeAppVersion = 'getNativeAppVersion';
  static const String methodGetAndroidSdkInt = 'getAndroidSdkInt';
  /// Sprint 3.
  static const String methodGetDevicePublicKey = 'getDevicePublicKey';

  // --- Sprint 4: Permission Manager ---
  static const String methodIsUsageAccessGranted = 'isUsageAccessGranted';
  static const String methodOpenUsageAccessSettings = 'openUsageAccessSettings';
  static const String methodIsAccessibilityServiceEnabled = 'isAccessibilityServiceEnabled';
  static const String methodOpenAccessibilitySettings = 'openAccessibilitySettings';
  static const String methodHasOverlayPermission = 'hasOverlayPermission';
  static const String methodRequestOverlayPermission = 'requestOverlayPermission';
  static const String methodIsBatteryOptimizationExempted = 'isBatteryOptimizationExempted';
  static const String methodRequestBatteryOptimizationExemption =
      'requestBatteryOptimizationExemption';
  static const String methodAreNotificationsGranted = 'areNotificationsGranted';

  // --- Sprint 4: Device Capability Engine ---
  static const String methodGetCapabilityReport = 'getCapabilityReport';

  // --- Methods still reserved for future steps — NOT implemented on the
  // native side yet. Calling any of these today throws
  // AgentCapabilityNotImplementedException:
  //   Foreground Service (Sprint 4, explicitly deferred — see
  //     docs/architecture/sprint4-android-native-layer.md):
  //     startAgentForegroundService, stopAgentForegroundService
  //   Anti-Tamper (Step 9, unscheduled in the current Sprint order):
  //     getTamperSignals
}
