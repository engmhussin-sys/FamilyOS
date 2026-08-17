package com.aifamilycoach.child_app.core

import android.Manifest
import android.accessibilityservice.AccessibilityServiceInfo
import android.app.AppOpsManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import android.view.accessibility.AccessibilityManager
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat

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

    // =====================================================================
    // ACCESSIBILITY — rewritten in F2 (audit MA-008 / verdict risk R6)
    //
    // WHY THIS WAS THE MOST DANGEROUS METHOD IN THE APP
    // This single boolean is the source of truth for FIVE mechanisms: the
    // capability report POSTed to the backend, the ongoing "protection is
    // on" notification, the `accessibility_disabled` anti-tamper signal,
    // the watchdog's alert, and DeviceHomeScreen's status badge. A wrong
    // answer does not degrade gracefully — it makes the app lie to the
    // parent in ONE FIXED DIRECTION, on every surface at once.
    //
    // WHAT WAS WRONG
    // The old implementation compared the setting's entries to a
    // hard-coded flattened string with `equals(ignoreCase = true)`. That
    // is a bet on ONE of the two encodings that exist in the wild:
    //   flattenToString()      -> "pkg/pkg.core.ChildGuardAccessibilityService"
    //   flattenToShortString() -> "pkg/.core.ChildGuardAccessibilityService"
    // AOSP's AccessibilityManagerService persists the list with
    // flattenToShortString(), while the Settings app's own toggle path has
    // historically written flattenToString(). Both forms occur depending
    // on Android version and OEM, so the previous "fix" may simply have
    // swapped one always-false device population for another.
    //
    // THE FIX: never compare strings. ComponentName.unflattenFromString()
    // normalises BOTH forms (it expands a leading "." using the package),
    // and ComponentName.equals() is therefore encoding-agnostic.
    //
    // PRIMARY SOURCE: AccessibilityManager.getEnabledAccessibilityServiceList()
    // Preferred because it is the framework's own answer to "which
    // accessibility services are enabled right now", already filtered by
    // user and by global state — no parsing, no encoding question, and it
    // cannot report a service as enabled while the master switch is off.
    //
    // FALLBACK: parse Settings.Secure. Kept because the manager list is
    // populated from the bound-service state, and there are OEM builds and
    // brief post-toggle windows where the setting already names us and the
    // manager has not caught up. The fallback is the ONLY path that needs
    // Settings.Secure.ACCESSIBILITY_ENABLED — that check (absent entirely
    // before F2) is what stops a stale, non-empty service list from being
    // read as "enabled" while accessibility is globally off.
    //
    // The two are OR'd, not AND'd, deliberately: a false NEGATIVE here
    // raises an `accessibility_disabled` tamper signal against a child who
    // did nothing, which is a CONTEXT §3.7 (non-punitive) violation, not
    // just a cosmetic bug.
    // =====================================================================

    /**
     * The ComponentName of THIS app's own enforcement service, derived
     * from the class rather than written out as a string. Immune to an
     * applicationIdSuffix, a package rename, or a typo — all three of
     * which silently produce a permanently-false check when the component
     * is hard-coded.
     */
    fun childGuardAccessibilityComponent(): ComponentName =
        ComponentName(context, ChildGuardAccessibilityService::class.java)

    /** The call every caller in this app should use. */
    fun isChildGuardAccessibilityServiceEnabled(): Boolean =
        isAccessibilityServiceEnabled(childGuardAccessibilityComponent())

    fun isAccessibilityServiceEnabled(target: ComponentName): Boolean {
        if (isEnabledPerAccessibilityManager(target)) return true
        return isEnabledPerSecureSettings(target)
    }

    /**
     * String-taking overload, kept only so an out-of-tree caller does not
     * break. It no longer compares strings: the argument is normalised
     * through ComponentName first, so passing either flattening form now
     * yields the same, correct answer.
     */
    @Deprecated(
        "Pass a ComponentName, or call isChildGuardAccessibilityServiceEnabled(). " +
            "A flattened string cannot express which of the two encodings the device uses.",
        ReplaceWith("isChildGuardAccessibilityServiceEnabled()"),
    )
    fun isAccessibilityServiceEnabled(serviceComponentName: String): Boolean {
        val target = ComponentName.unflattenFromString(serviceComponentName) ?: return false
        return isAccessibilityServiceEnabled(target)
    }

    private fun isEnabledPerAccessibilityManager(target: ComponentName): Boolean {
        val manager =
            context.getSystemService(Context.ACCESSIBILITY_SERVICE) as? AccessibilityManager
                ?: return false
        val enabled = try {
            manager.getEnabledAccessibilityServiceList(AccessibilityServiceInfo.FEEDBACK_ALL_MASK)
        } catch (t: Throwable) {
            // Some OEM builds have historically thrown from this path.
            // Falling through to the Settings.Secure parse is strictly
            // better than propagating an exception into a status check
            // that runs inside a foreground-service loop.
            null
        } ?: return false
        return enabled.any { componentOf(it) == target }
    }

    /**
     * `AccessibilityServiceInfo.getId()` is documented as the flattened
     * component name, but which flattening is, again, not guaranteed —
     * so it goes through unflattenFromString like everything else, with
     * the ResolveInfo as a second route when the id is unparseable.
     */
    private fun componentOf(info: AccessibilityServiceInfo): ComponentName? {
        ComponentName.unflattenFromString(info.id ?: "")?.let { return it }
        val serviceInfo = info.resolveInfo?.serviceInfo ?: return null
        return ComponentName(serviceInfo.packageName, serviceInfo.name)
    }

    private fun isEnabledPerSecureSettings(target: ComponentName): Boolean {
        val resolver = context.contentResolver
        // MISSING ENTIRELY BEFORE F2 (audit MA-008). The services list can
        // be non-empty while the global accessibility switch is off.
        val globallyEnabled = Settings.Secure.getInt(
            resolver,
            Settings.Secure.ACCESSIBILITY_ENABLED,
            0,
        )
        if (globallyEnabled != 1) return false

        val raw = Settings.Secure.getString(
            resolver,
            Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES,
        )
        if (raw.isNullOrEmpty()) return false

        return raw.split(':')
            .mapNotNull { ComponentName.unflattenFromString(it.trim()) }
            .any { it == target }
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
     * MainActivity (see NotificationPermissionRequester), not this class —
     * PermissionManager only reports the current state here.
     */
    fun requiresRuntimeNotificationPermission(): Boolean {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
    }

    /**
     * G18. The PERMISSION-level answer, deliberately distinct from
     * [areNotificationsGranted] above, which reports whether notifications are
     * enabled for this app AS A WHOLE.
     *
     * THE DIFFERENCE MATTERS AND IS THE REASON BOTH EXIST:
     * `areNotificationsEnabled()` is false both when POST_NOTIFICATIONS was
     * never granted AND when the user muted the app from Settings, so it
     * cannot answer "is there still a runtime dialog worth showing?". Only a
     * permission check can, and showing a dialog Android will never display is
     * exactly how an app ends up with a dead button.
     *
     * Below API 33 the permission is granted at install time, so this is true
     * there by definition.
     */
    fun isPostNotificationsPermissionGranted(): Boolean {
        if (!requiresRuntimeNotificationPermission()) return true
        return ContextCompat.checkSelfPermission(
            context,
            Manifest.permission.POST_NOTIFICATIONS,
        ) == PackageManager.PERMISSION_GRANTED
    }

    /**
     * Opens this app's own notification settings page — the only route left
     * once Android has stopped showing the runtime dialog (declined twice, or
     * "don't ask again").
     *
     * Never throws, and falls back from the notification-specific screen to
     * the app-details screen: a missing OEM Activity is the single most common
     * crash in code that ships this feature, the same reasoning
     * OemBackgroundRestrictionManager already applies to autostart screens.
     */
    fun openNotificationSettings(): Boolean {
        val candidates = mutableListOf<Intent>()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            candidates += Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
                putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
                flags = Intent.FLAG_ACTIVITY_NEW_TASK
            }
        }
        candidates += Intent(
            Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
            Uri.parse("package:${context.packageName}"),
        ).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK
        }

        for (intent in candidates) {
            try {
                context.startActivity(intent)
                return true
            } catch (_: Throwable) {
                // Fall through to the next, less specific screen.
            }
        }
        return false
    }
}
