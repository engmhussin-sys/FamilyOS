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

    // --- Child Runtime Engine: Anti-Tamper ---
    const val METHOD_CHECK_TAMPER_SIGNALS = "checkTamperSignals"

    /** Placeholder component name — the real AccessibilityService class
     * doesn't exist yet (this project's explicitly flagged highest-risk,
     * not-yet-built piece). Using this placeholder means
     * isAccessibilityServiceEnabled/getCapabilityReport correctly report
     * "false" today rather than referencing a nonexistent class. */
    const val ACCESSIBILITY_SERVICE_COMPONENT_NAME_PLACEHOLDER =
        "com.aifamilycoach.child_app/.core.ChildGuardAccessibilityService"
}
