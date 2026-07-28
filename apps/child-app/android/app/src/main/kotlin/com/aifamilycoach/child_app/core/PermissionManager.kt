package com.aifamilycoach.child_app.core

import android.app.AppOpsManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.core.app.NotificationManagerCompat

/**
 * Sprint 4's Permission Manager. Deliberately narrow: every method here
 * either CHECKS a permission's current state (read-only, safe) or
 * LAUNCHES the relevant system Settings screen (a user-driven action,
 * not a silent grant — none of these permissions can be granted
 * programmatically, per child-agent-android-enforcement.md §5). No
 * AccessibilityService/UsageStatsManager logic lives here — this class
 * only manages ACCESS TO those, not their behavior once granted.
 */
class PermissionManager(private val context: Context) {

    fun isUsageAccessGranted(): Boolean {
        val appOps = context.getSystemService(Context.APP_OPS_SERVICE) as AppOpsManager
        val mode = appOps.unsafeCheckOpNoThrow(
            AppOpsManager.OPSTR_GET_USAGE_STATS,
            android.os.Process.myUid(),
            context.packageName,
        )
        return mode == AppOpsManager.MODE_ALLOWED
    }

    fun openUsageAccessSettings() {
        val intent = Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK
        }
        context.startActivity(intent)
    }

    /**
     * Whether OUR AccessibilityService is enabled — checks the
     * system-wide enabled-services string for our own service's
     * component name. Does not require the service class to exist yet;
     * this check will simply return false until Sprint 4's dedicated
     * AccessibilityService pass adds it (flagged, not silently assumed).
     */
    fun isAccessibilityServiceEnabled(serviceComponentName: String): Boolean {
        val enabledServices = Settings.Secure.getString(
            context.contentResolver,
            Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES,
        ) ?: return false
        return enabledServices.split(":").any { it.equals(serviceComponentName, ignoreCase = true) }
    }

    fun openAccessibilitySettings() {
        val intent = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK
        }
        context.startActivity(intent)
    }

    fun hasOverlayPermission(): Boolean {
        return Settings.canDrawOverlays(context)
    }

    fun requestOverlayPermission() {
        val intent = Intent(
            Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
            Uri.parse("package:${context.packageName}"),
        ).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK
        }
        context.startActivity(intent)
    }

    fun isBatteryOptimizationExempted(): Boolean {
        val powerManager = context.getSystemService(Context.POWER_SERVICE) as PowerManager
        return powerManager.isIgnoringBatteryOptimizations(context.packageName)
    }

    fun requestBatteryOptimizationExemption() {
        val intent = Intent(
            Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
            Uri.parse("package:${context.packageName}"),
        ).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK
        }
        context.startActivity(intent)
    }

    fun areNotificationsGranted(): Boolean {
        return NotificationManagerCompat.from(context).areNotificationsEnabled()
    }

    /**
     * POST_NOTIFICATIONS is a normal runtime permission (Android 13+/API
     * 33+, unlike the special-access permissions above) — it must be
     * requested via `ActivityCompat.requestPermissions` from an Activity
     * context, not a Settings deep-link. That call site belongs to
     * MainActivity (or a future onboarding Activity), not this class —
     * PermissionManager only reports the current state here.
     */
    fun requiresRuntimeNotificationPermission(): Boolean {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
    }
}
