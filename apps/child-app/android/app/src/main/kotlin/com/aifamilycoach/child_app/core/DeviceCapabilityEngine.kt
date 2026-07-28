package com.aifamilycoach.child_app.core

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import java.security.MessageDigest

/**
 * Sprint 4's Device Capability Engine. `collect()` (unchanged from the
 * previous session) is the flat report the BACKEND already expects
 * (report-capabilities.dto.ts) — kept exactly as-is so nothing already
 * verified breaks. `collectExpanded()` (new, Child Runtime Engine) is
 * the fuller supported/granted/required/optional/confidence matrix from
 * child-runtime-engine.md §4 — additive, not a replacement; no backend
 * endpoint consumes it yet (flagged as a follow-up, not silently assumed
 * wired).
 */
class DeviceCapabilityEngine(private val context: Context) {
    private val permissionManager = PermissionManager(context)

    fun collect(accessibilityServiceComponentName: String): DeviceCapabilityReport {
        val report = DeviceCapabilityReport(
            manufacturer = Build.MANUFACTURER,
            model = Build.MODEL,
            sdkInt = Build.VERSION.SDK_INT,
            usageAccessGranted = permissionManager.isUsageAccessGranted(),
            accessibilityEnabled = permissionManager.isAccessibilityServiceEnabled(
                accessibilityServiceComponentName,
            ),
            overlayGranted = permissionManager.hasOverlayPermission(),
            batteryOptimizationExempted = permissionManager.isBatteryOptimizationExempted(),
            notificationsGranted = permissionManager.areNotificationsGranted(),
        )
        return report.copy(profileHash = computeHash(report))
    }

    fun collectExpanded(accessibilityServiceComponentName: String): List<CapabilityEntry> {
        val pm = context.packageManager
        val entries = mutableListOf<CapabilityEntry>()

        entries += CapabilityEntry("accessibility", true,
            permissionManager.isAccessibilityServiceEnabled(accessibilityServiceComponentName), true, 1.0)
        entries += CapabilityEntry("overlay", true, permissionManager.hasOverlayPermission(), true, 1.0)
        entries += CapabilityEntry("usage_access", true, permissionManager.isUsageAccessGranted(), true, 1.0)
        entries += CapabilityEntry("notifications", true, permissionManager.areNotificationsGranted(), false, 1.0)
        entries += CapabilityEntry(
            "battery_optimization_exemption", true, permissionManager.isBatteryOptimizationExempted(), true, 1.0,
        )
        entries += hardwareCapability(pm, "location", PackageManager.FEATURE_LOCATION, required = false)
        entries += hardwareCapability(pm, "bluetooth", PackageManager.FEATURE_BLUETOOTH, required = false)
        entries += hardwareCapability(pm, "camera", PackageManager.FEATURE_CAMERA_ANY, required = false)
        entries += hardwareCapability(pm, "microphone", PackageManager.FEATURE_MICROPHONE, required = false)
        entries += hardwareCapability(
            pm, "activity_recognition", "android.hardware.sensor.stepcounter", required = false,
        )
        entries += hardwareCapability(pm, "nfc", PackageManager.FEATURE_NFC, required = false)
        entries += CapabilityEntry(
            "biometric",
            pm.hasSystemFeature(PackageManager.FEATURE_FINGERPRINT) ||
                (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && pm.hasSystemFeature(PackageManager.FEATURE_FACE)),
            granted = false, // biometric auth isn't requested by this app at all yet — always false, honestly
            required = false,
            confidence = 0.8,
        )
        entries += CapabilityEntry(
            "exact_alarm",
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.S,
            granted = false, // SCHEDULE_EXACT_ALARM not requested yet — Track B's Runtime Watchdog scope
            required = false,
            confidence = 0.6,
        )
        entries += CapabilityEntry(
            "background_execution", true,
            granted = permissionManager.isBatteryOptimizationExempted(), // practical proxy for this today
            required = true,
            confidence = 0.7,
        )

        return entries
    }

    private fun hardwareCapability(
        pm: PackageManager,
        id: String,
        feature: String,
        required: Boolean,
    ): CapabilityEntry {
        val supported = pm.hasSystemFeature(feature)
        return CapabilityEntry(
            id = id,
            supported = supported,
            // Hardware-only features report "granted" as false until this
            // app actually requests the runtime permission that gates
            // them (Camera/Microphone/Location) — Track B/future scope,
            // not assumed granted just because the hardware exists.
            granted = false,
            required = required,
            confidence = 0.9,
        )
    }

    private fun computeHash(report: DeviceCapabilityReport): String {
        val canonical = listOf(
            report.manufacturer, report.model, report.sdkInt.toString(),
            report.usageAccessGranted.toString(), report.accessibilityEnabled.toString(),
            report.overlayGranted.toString(), report.batteryOptimizationExempted.toString(),
            report.notificationsGranted.toString(),
        ).joinToString("|")
        val digest = MessageDigest.getInstance("SHA-256").digest(canonical.toByteArray())
        return digest.joinToString("") { "%02x".format(it) }
    }
}

data class DeviceCapabilityReport(
    val manufacturer: String,
    val model: String,
    val sdkInt: Int,
    val usageAccessGranted: Boolean,
    val accessibilityEnabled: Boolean,
    val overlayGranted: Boolean,
    val batteryOptimizationExempted: Boolean,
    val notificationsGranted: Boolean,
    val profileHash: String = "",
)

data class CapabilityEntry(
    val id: String,
    val supported: Boolean,
    val granted: Boolean,
    val required: Boolean,
    val confidence: Double,
)
