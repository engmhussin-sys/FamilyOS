package com.aifamilycoach.child_app.core

import android.content.Context
import android.os.Build
import android.provider.Settings
import java.io.File

/**
 * Sprint 4 (Child Runtime Engine) — "Anti-Tamper... do not postpone."
 * Implements exactly the subset of `IAntiTamper.dart`'s `TamperSignal`
 * enum that's checkable WITHOUT the Foreground Runtime or Boot Manager
 * existing (both Track B): `accessibilityDisabled`, `usageAccessDisabled`,
 * `rootDetected`, `mockLocationDetected`, `emulatorDetected`,
 * `developerModeEnabled`, `usbDebuggingEnabled`. The other seven
 * (`serviceDisabled`, `appForceStopped`, `apkReinstalled`,
 * `deviceRebooted`, `permissionsRevoked`, `timeManipulationDetected`,
 * `factoryResetDetected`) genuinely need a running service or boot
 * receiver to have a "before" state to compare against — flagged in
 * docs/architecture/child-runtime-engine.md §7, not silently omitted.
 *
 * Every check here is read-only — same risk profile as PermissionManager.
 */
class AntiTamperDetector(private val context: Context) {

    /**
     * F2 (audit MA-008 / R6): the flattened-component-name parameter is
     * gone. It was only ever forwarded to PermissionManager, which now
     * derives the ComponentName from the service class itself — so the
     * parameter could only ever have been a way to get it WRONG.
     */
    fun checkAll(): List<String> {
        val permissionManager = PermissionManager(context)
        val signals = mutableListOf<String>()

        if (!permissionManager.isChildGuardAccessibilityServiceEnabled()) {
            signals.add("accessibility_disabled")
        }
        if (!permissionManager.isUsageAccessGranted()) {
            signals.add("usage_access_disabled")
        }
        if (isRootDetected()) {
            signals.add("root_detected")
        }
        if (isMockLocationEnabled()) {
            signals.add("mock_location_detected")
        }
        if (isLikelyEmulator()) {
            signals.add("emulator_detected")
        }
        if (isDeveloperModeEnabled()) {
            signals.add("developer_mode_enabled")
        }
        if (isUsbDebuggingEnabled()) {
            signals.add("usb_debugging_enabled")
        }

        return signals
    }

    /** Standard, non-invasive root heuristics — common su binary paths
     * and test-keys build tags. Not exhaustive (a dedicated library like
     * RootBeer is the real production answer), but a legitimate first
     * pass with zero extra dependencies. */
    private fun isRootDetected(): Boolean {
        val suPaths = listOf(
            "/system/bin/su", "/system/xbin/su", "/sbin/su",
            "/system/su", "/system/bin/.ext/.su",
        )
        if (suPaths.any { File(it).exists() }) return true
        return Build.TAGS?.contains("test-keys") == true
    }

    private fun isMockLocationEnabled(): Boolean {
        return try {
            @Suppress("DEPRECATION")
            Settings.Secure.getString(context.contentResolver, Settings.Secure.ALLOW_MOCK_LOCATION) == "1"
        } catch (e: Exception) {
            false
        }
    }

    private fun isLikelyEmulator(): Boolean {
        return Build.FINGERPRINT.startsWith("generic") ||
            Build.FINGERPRINT.startsWith("unknown") ||
            Build.MODEL.contains("google_sdk") ||
            Build.MODEL.contains("Emulator") ||
            Build.MODEL.contains("Android SDK built for x86") ||
            Build.MANUFACTURER.contains("Genymotion") ||
            (Build.BRAND.startsWith("generic") && Build.DEVICE.startsWith("generic")) ||
            Build.PRODUCT == "google_sdk"
    }

    private fun isDeveloperModeEnabled(): Boolean {
        return Settings.Secure.getInt(
            context.contentResolver,
            Settings.Global.DEVELOPMENT_SETTINGS_ENABLED,
            0,
        ) == 1
    }

    private fun isUsbDebuggingEnabled(): Boolean {
        return Settings.Secure.getInt(
            context.contentResolver,
            Settings.Global.ADB_ENABLED,
            0,
        ) == 1
    }
}
