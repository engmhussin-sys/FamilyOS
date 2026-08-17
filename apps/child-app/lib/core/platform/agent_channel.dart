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

  /// G18 — asks for POST_NOTIFICATIONS and returns the platform's answer as one
  /// of the `NotificationPermissionOutcome` wire strings: 'granted',
  /// 'already_granted', 'not_required', 'denied', 'permanently_denied'.
  ///
  /// A STRING, not a bool, because the caller must distinguish "declined once"
  /// (worth offering again another day) from "declined for good" (Android will
  /// never show the dialog again, so only the settings route remains).
  ///
  /// The raw wire string stops here, exactly as [getCapabilityReport] keeps a
  /// raw Map at this boundary: the typed `NotificationPermissionOutcome` is
  /// produced one layer up, in the permissions plugin.
  Future<String> requestNotificationsPermission();

  /// G18 — opens this app's own notification settings page. Returns whether a
  /// screen actually opened; the native side never throws on a device that has
  /// no such Activity.
  Future<bool> openNotificationSettings();

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

  // --- Child Runtime Engine: Runtime Telemetry ---
  Future<Map<Object?, Object?>> getRuntimeHealth();

  // --- Edge-First Intelligence Architecture: Digital Wellbeing ---
  // CLOSES THE GAP `DailyUsageTracker.kt` (existing) left open: that
  // class only ever computed a single TOTAL minutes-used-today number
  // for the bedtime/daily-limit rule engine. These two methods expose
  // Android's OWN aggregate UsageStatsManager/UsageEvents APIs with
  // real per-app and pickup granularity — still aggregated by Android
  // itself, never per-tap/per-second raw logging on this app's part.

  /// Per-app foreground minutes for today, using the same
  /// `UsageStatsManager.queryUsageStats` API `DailyUsageTracker.kt`
  /// already uses for its total — this is that same data, kept
  /// per-package instead of summed. Keys are package names.
  Future<Map<Object?, Object?>> getTodayAppUsageBreakdown();

  /// Count of foreground-app-launch events today, via Android's
  /// `UsageEvents.Event.ACTIVITY_RESUMED` — a standard, Android-provided
  /// aggregate signal (how many times any app was brought to the
  /// foreground), not a custom tap-tracking mechanism.
  Future<int> getTodayPickupCount();

  // --- Sprint 14 (Behavioral Intelligence Engine) ---
  /// On-device category classification per package (AppCategoryClassifier.kt)
  /// — a SEPARATE method from getTodayAppUsageBreakdown above (not a
  /// breaking change to it) so existing callers of that method are
  /// entirely unaffected. Keys are package names, values are category
  /// strings (e.g. "EDUCATION", "GAMING", "OTHER").
  Future<Map<Object?, Object?>> getTodayAppCategories();

  /// Session-level stats (count, average, longest, usage-by-hour) —
  /// computed from the same UsageEvents stream getTodayPickupCount
  /// already reads, via SessionAnalyzer.kt.
  Future<Map<Object?, Object?>> getTodaySessionStats();

  // --- Sprint 5: Runtime Enforcement Engine ---
  /// Pushes the currently-synced policy into native storage
  /// (NativePolicyStore.kt) so ChildGuardAccessibilityService can
  /// enforce it even if this Flutter engine later isn't running.
  Future<void> syncPolicyToNative({
    required int? dailyLimitMinutes,
    required String? bedtimeStart,
    required String? bedtimeEnd,
    required bool focusModeEnabled,
    required List<String> blockedPackages,
  });

  Future<Map<Object?, Object?>> getEnforcementStatus();

  Future<void> startEnforcementService();

  // --- F2 (audit verdict R7): OEM background-restriction onboarding ---

  /// Describes this device's manufacturer-specific "keep this app
  /// running" screen. Keys: `manufacturer`, `brand`, `oemKey`,
  /// `hasOemIntent`, `batteryExempt`.
  ///
  /// `oemKey` is one of `xiaomi`, `oppo`, `vivo`, `huawei`, `samsung`,
  /// `transsion`, `generic` — never null, never an error: an unrecognised
  /// manufacturer is a normal answer (`generic`), not a failure.
  Future<Map<Object?, Object?>> getOemBackgroundRestrictionInfo();

  /// Opens the best screen this device actually has: the vendor autostart
  /// list, else the platform battery-optimisation list, else this app's
  /// settings page. Returns which one opened (`oem_autostart`,
  /// `battery_optimization`, `app_details`, `none`) so the UI can describe
  /// what the user is looking at instead of guessing.
  ///
  /// The native side never throws for a missing OEM Activity — that is the
  /// single most common crash in apps that ship this feature.
  Future<String> openOemBackgroundSettings();
}
