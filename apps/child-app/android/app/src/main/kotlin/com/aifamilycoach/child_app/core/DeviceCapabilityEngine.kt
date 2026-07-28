package com.aifamilycoach.child_app.core

import android.content.Context
import android.os.Build
import java.security.MessageDigest

/**
 * Sprint 4's Device Capability Engine (the "Full Capability Engine" from
 * pairing-backend-domain-architecture.md §2/§3, arriving as promised).
 * Composes PermissionManager's checks into the report shape the
 * backend's `POST /pairing/device/capabilities` expects
 * (report-capabilities.dto.ts) and computes its own SHA-256 hash
 * (Decision-019) so the caller can decide whether it's even worth
 * sending — no network/backend awareness lives in this class, only
 * device-side data collection.
 */
class DeviceCapabilityEngine(context: Context) {
    private val permissionManager = PermissionManager(context)

    /**
     * `accessibilityServiceComponentName` is passed in rather than
     * hardcoded — this class doesn't need to know the AccessibilityService
     * class exists yet (Sprint 4's separately-flagged, highest-risk
     * piece); it just checks whatever component name it's given.
     */
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

    private fun computeHash(report: DeviceCapabilityReport): String {
        val canonical = listOf(
            report.manufacturer,
            report.model,
            report.sdkInt.toString(),
            report.usageAccessGranted.toString(),
            report.accessibilityEnabled.toString(),
            report.overlayGranted.toString(),
            report.batteryOptimizationExempted.toString(),
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
