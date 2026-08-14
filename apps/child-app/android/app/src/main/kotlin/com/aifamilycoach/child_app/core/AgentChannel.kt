package com.aifamilycoach.child_app.core

/**
 * MUST mirror lib/core/platform/agent_channel_constants.dart exactly.
 * There is no compile-time link between the two languages, so a
 * mismatch here is a silent runtime failure — this is why both sides
 * keep these as named constants instead of inline string literals, and
 * why the Step 1 diagnostic screen exists at all (to make a mismatch
 * immediately visible during development rather than surfacing later as
 * a confusing bug in Step 5+).
 */
object AgentChannel {
    const val CHANNEL_NAME = "com.aifamilycoach.child_app/agent"

    const val METHOD_GET_NATIVE_APP_VERSION = "getNativeAppVersion"
    const val METHOD_GET_ANDROID_SDK_INT = "getAndroidSdkInt"
    /** Sprint 3 — see DeviceIdentityKeyManager. */
    const val METHOD_GET_DEVICE_PUBLIC_KEY = "getDevicePublicKey"

    // --- Sprint 4: Permission Manager ---
    const val METHOD_IS_USAGE_ACCESS_GRANTED = "isUsageAccessGranted"
    const val METHOD_OPEN_USAGE_ACCESS_SETTINGS = "openUsageAccessSettings"
    const val METHOD_IS_ACCESSIBILITY_SERVICE_ENABLED = "isAccessibilityServiceEnabled"
    const val METHOD_OPEN_ACCESSIBILITY_SETTINGS = "openAccessibilitySettings"
    const val METHOD_HAS_OVERLAY_PERMISSION = "hasOverlayPermission"
    const val METHOD_REQUEST_OVERLAY_PERMISSION = "requestOverlayPermission"
    const val METHOD_IS_BATTERY_OPTIMIZATION_EXEMPTED = "isBatteryOptimizationExempted"
    const val METHOD_REQUEST_BATTERY_OPTIMIZATION_EXEMPTION = "requestBatteryOptimizationExemption"
    const val METHOD_ARE_NOTIFICATIONS_GRANTED = "areNotificationsGranted"

    // --- Sprint 4: Device Capability Engine ---
    const val METHOD_GET_CAPABILITY_REPORT = "getCapabilityReport"

    // --- Sprint 4: Runtime Telemetry ---
    const val METHOD_GET_RUNTIME_HEALTH = "getRuntimeHealth"

    // --- Edge-First Intelligence Architecture: Digital Wellbeing ---
    const val METHOD_GET_TODAY_APP_USAGE_BREAKDOWN = "getTodayAppUsageBreakdown"
    const val METHOD_GET_TODAY_PICKUP_COUNT = "getTodayPickupCount"
    // Sprint 14 (Behavioral Intelligence Engine)
    const val METHOD_GET_TODAY_SESSION_STATS = "getTodaySessionStats"

    // --- Child Runtime Engine: Anti-Tamper ---
    const val METHOD_CHECK_TAMPER_SIGNALS = "checkTamperSignals"

    // --- Sprint 5: Runtime Enforcement Engine ---
    const val METHOD_SYNC_POLICY_TO_NATIVE = "syncPolicyToNative"
    const val METHOD_GET_ENFORCEMENT_STATUS = "getEnforcementStatus"
    const val METHOD_START_ENFORCEMENT_SERVICE = "startEnforcementService"

    // --- F2 (audit MA-008 / verdict risk R6): OEM autostart & battery ---
    /**
     * Returns a map describing the manufacturer-specific "keep this app
     * running" screen, if this device has one:
     *   manufacturer  : Build.MANUFACTURER, lower-cased
     *   oemKey        : stable id ("xiaomi", "oppo", "vivo", "huawei",
     *                   "samsung", "transsion", or "generic")
     *   hasOemIntent  : whether a resolvable OEM Activity was found
     *   batteryExempt : PowerManager.isIgnoringBatteryOptimizations()
     * Never throws for an unknown manufacturer — it returns "generic".
     */
    const val METHOD_GET_OEM_BACKGROUND_RESTRICTION_INFO = "getOemBackgroundRestrictionInfo"

    /**
     * Opens the OEM autostart screen, falling back to the platform
     * battery-optimisation screen, falling back to this app's own
     * Settings page. Returns the id of whatever was actually opened, so
     * the UI can tell the child what they are looking at instead of
     * guessing. Returns "none" if every attempt failed.
     */
    const val METHOD_OPEN_OEM_BACKGROUND_SETTINGS = "openOemBackgroundSettings"

    /**
     * REMOVED IN F2 (audit MA-008 / verdict risk R6) — do not reintroduce.
     *
     * This constant held a hard-coded, FLATTENED component name that was
     * string-compared against `Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES`.
     * That comparison could not be right on all devices, because two
     * encodings exist in the wild for the same component:
     *   flattenToString()      -> "pkg/pkg.core.ChildGuardAccessibilityService"
     *   flattenToShortString() -> "pkg/.core.ChildGuardAccessibilityService"
     * AOSP persists the SHORT form; the Settings app has historically
     * written the LONG one. Sprint 10 "fixed" the value by switching to
     * the long form — consistently, across all six call sites, which is
     * why the audit could confirm the consistency and not the
     * correctness. It may simply have moved the always-false population
     * from one set of devices to another.
     *
     * There is now no string to get wrong: `PermissionManager` builds a
     * `ComponentName` from `ChildGuardAccessibilityService::class.java`
     * and compares ComponentName-to-ComponentName, which is
     * encoding-agnostic by construction. Every call site passes nothing.
     *
     * Kept as a deprecated constant rather than deleted outright so that
     * anything referencing it out of tree fails loudly at the deprecation
     * rather than silently resolving to a value that means nothing now.
     */
    @Deprecated(
        "Component-name STRINGS cannot be compared safely against " +
            "ENABLED_ACCESSIBILITY_SERVICES (two flattening encodings exist in the wild). " +
            "Use PermissionManager.isChildGuardAccessibilityServiceEnabled().",
        level = DeprecationLevel.WARNING,
    )
    const val ACCESSIBILITY_SERVICE_COMPONENT_NAME =
        "com.aifamilycoach.child_app/com.aifamilycoach.child_app.core.ChildGuardAccessibilityService"

    @Deprecated(
        "Superseded twice: first renamed, then made obsolete entirely by the ComponentName-based " +
            "check introduced in F2. Use PermissionManager.isChildGuardAccessibilityServiceEnabled().",
        level = DeprecationLevel.WARNING,
    )
    @Suppress("DEPRECATION")
    const val ACCESSIBILITY_SERVICE_COMPONENT_NAME_PLACEHOLDER = ACCESSIBILITY_SERVICE_COMPONENT_NAME
}
