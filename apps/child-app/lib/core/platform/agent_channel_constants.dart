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

  /// G18 — requests POST_NOTIFICATIONS. Answers with one of the
  /// `NotificationPermissionOutcome` wire strings, never a bool.
  static const String methodRequestNotificationsPermission =
      'requestNotificationsPermission';

  /// G18 — opens this app's own notification settings page, the only route
  /// left once Android has stopped showing the runtime dialog.
  static const String methodOpenNotificationSettings = 'openNotificationSettings';

  // --- Sprint 4: Device Capability Engine ---
  static const String methodGetCapabilityReport = 'getCapabilityReport';

  // --- Child Runtime Engine: Anti-Tamper ---
  static const String methodCheckTamperSignals = 'checkTamperSignals';

  // --- Child Runtime Engine: Runtime Telemetry ---
  static const String methodGetRuntimeHealth = 'getRuntimeHealth';
  static const String methodGetTodayAppUsageBreakdown = 'getTodayAppUsageBreakdown';
  static const String methodGetTodayPickupCount = 'getTodayPickupCount';
  // Sprint 14 (Behavioral Intelligence Engine) — must match the exact
  // string literals used in MainActivity.kt's `when` block.
  static const String methodGetTodayAppCategories = 'getTodayAppCategories';
  static const String methodGetTodaySessionStats = 'getTodaySessionStats';

  // --- F2 (audit verdict R7): OEM background-restriction onboarding ---
  // Must match AgentChannel.kt's METHOD_GET_OEM_BACKGROUND_RESTRICTION_INFO
  // and METHOD_OPEN_OEM_BACKGROUND_SETTINGS exactly.
  static const String methodGetOemBackgroundRestrictionInfo =
      'getOemBackgroundRestrictionInfo';
  static const String methodOpenOemBackgroundSettings = 'openOemBackgroundSettings';

  // --- Sprint 5: Runtime Enforcement Engine ---
  static const String methodSyncPolicyToNative = 'syncPolicyToNative';
  static const String methodGetEnforcementStatus = 'getEnforcementStatus';
  static const String methodStartEnforcementService = 'startEnforcementService';

  // --- Methods still reserved for future steps — NOT implemented on the
  // native side yet. Calling any of these today throws
  // AgentCapabilityNotImplementedException:
  //   Foreground Service (Sprint 4, explicitly deferred — see
  //     docs/architecture/sprint4-android-native-layer.md):
  //     startAgentForegroundService, stopAgentForegroundService
  //   Anti-Tamper (Step 9, unscheduled in the current Sprint order):
  //     getTamperSignals
}
