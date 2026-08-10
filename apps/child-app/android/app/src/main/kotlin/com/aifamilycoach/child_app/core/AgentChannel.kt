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

    /** CRITICAL FIX (Sprint 10 Android Runtime Audit): this held the
     * manifest's SHORTHAND relative class reference
     * (`"com.aifamilycoach.child_app/.core.ChildGuardAccessibilityService"`)
     * — but `Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES` (the only
     * place this constant is ever compared against, in
     * `PermissionManager.isAccessibilityServiceEnabled`) returns the
     * FULLY QUALIFIED form (`ComponentName.flattenToString()`:
     * `package/fully.qualified.ClassName`), never the shorthand form.
     * The string comparison was silently always false — exactly the
     * "parent sees 'protected,' child isn't" failure mode this file's
     * own docstring warned about, undetected until this audit because
     * nothing in the sandbox could exercise the real Android Settings
     * API to catch it. Renamed to drop "_PLACEHOLDER" now that it both
     * holds a real value AND is verified correct in format. */
    const val ACCESSIBILITY_SERVICE_COMPONENT_NAME =
        "com.aifamilycoach.child_app/com.aifamilycoach.child_app.core.ChildGuardAccessibilityService"

    @Deprecated(
        "Renamed to ACCESSIBILITY_SERVICE_COMPONENT_NAME after the Sprint 10 audit fixed its value " +
            "(the old name/value pair was silently always-false against the real Android Settings API). " +
            "Kept as an alias only so nothing breaks if referenced externally; do not use in new code.",
        ReplaceWith("ACCESSIBILITY_SERVICE_COMPONENT_NAME"),
    )
    const val ACCESSIBILITY_SERVICE_COMPONENT_NAME_PLACEHOLDER = ACCESSIBILITY_SERVICE_COMPONENT_NAME
}
