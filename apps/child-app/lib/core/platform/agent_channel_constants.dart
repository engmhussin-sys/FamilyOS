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

  // --- Methods reserved for future steps — NOT implemented on the native
  // side yet. Listed here so the full eventual contract is visible in one
  // place, even though calling any of these today throws
  // AgentCapabilityNotImplementedException. Each will move into the
  // "implemented" section above as its step lands:
  //   Step 4  (Capability Engine):  getDeviceCapabilityProfile
  //   Step 5  (Permission Manager): isAccessibilityServiceEnabled,
  //                                 isUsageAccessGranted,
  //                                 hasOverlayPermission,
  //                                 requestOverlayPermission,
  //                                 openAccessibilitySettings,
  //                                 openUsageAccessSettings,
  //                                 requestBatteryOptimizationExemption
  //   Step 6  (Foreground Service): startAgentForegroundService,
  //                                 stopAgentForegroundService
  //   Step 9  (Anti-Tamper):        getTamperSignals
}
