/// Port (in the same sense as the backend's repository ports) for
/// everything the Child Agent needs from native Android code. Application
/// logic depends on this abstraction, never directly on
/// `MethodChannel` — exactly the dependency-inversion pattern used
/// throughout the backend (see docs/architecture/children-module.md §2
/// for the same instinct applied to a different layer).
///
/// Step 1 (Core Architecture) intentionally exposes only enough to prove
/// the channel is wired correctly end-to-end. Steps 4–9 (Capability
/// Engine, Permission Manager, Foreground Service, Anti-Tamper) will each
/// add their own methods here alongside their native implementation —
/// see agent_channel_constants.dart for the full planned method list.
abstract class AgentPlatformChannel {
  /// The native Android app's versionName (from build.gradle) — a simple,
  /// low-risk round-trip used to confirm the channel works before any
  /// real capability is built on top of it.
  Future<String> getNativeAppVersion();

  /// `Build.VERSION.SDK_INT` — needed early because several future
  /// decisions (which enforcement APIs are available) branch on this,
  /// per the Capability-Based Engine principle from Decision-007: this
  /// value feeds capability decisions, not version-number branching in
  /// application code directly.
  Future<int> getAndroidSdkInt();

  /// Sprint 3 — returns the device's Keystore-backed identity public key
  /// (Base64-encoded X.509 SubjectPublicKeyInfo), generating it on first
  /// call if it doesn't exist yet. See
  /// android/.../core/DeviceIdentityKeyManager.kt.
  Future<String> getDevicePublicKey();

  // --- Sprint 4: Permission Manager ---
  Future<bool> isUsageAccessGranted();
  Future<void> openUsageAccessSettings();
  Future<bool> isAccessibilityServiceEnabled();
  Future<void> openAccessibilitySettings();
  Future<bool> hasOverlayPermission();
  Future<void> requestOverlayPermission();
  Future<bool> isBatteryOptimizationExempted();
  Future<void> requestBatteryOptimizationExemption();
  Future<bool> areNotificationsGranted();

  // --- Sprint 4: Device Capability Engine ---
  /// Returns the raw field map exactly matching the backend's
  /// ReportCapabilitiesDto shape — kept as a Map here (not a typed
  /// class) since this is the platform-channel boundary; the typed
  /// `DeviceCapabilityReport` model lives in
  /// features/device_status/domain, one layer up.
  Future<Map<Object?, Object?>> getCapabilityReport();

  // --- Child Runtime Engine: Anti-Tamper ---
  /// Returns raw signal-id strings (e.g. "accessibility_disabled") —
  /// mapped to TamperSignal by the plugin layer, not here, keeping this
  /// port a thin platform boundary.
  Future<List<Object?>> checkTamperSignals();
}
