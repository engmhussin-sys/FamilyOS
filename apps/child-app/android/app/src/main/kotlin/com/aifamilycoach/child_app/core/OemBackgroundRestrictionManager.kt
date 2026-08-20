package com.aifamilycoach.child_app.core

import android.content.ActivityNotFoundException
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings

/**
 * F2 — audit verdict risk R7: "process survival on Chinese OEMs".
 *
 * THE PROBLEM THIS SOLVES
 * `START_STICKY` + WorkManager + a BootReceiver is the complete standard
 * Android answer, and on Xiaomi/MIUI, Oppo/ColorOS, Vivo/Funtouch,
 * Huawei/EMUI and the Transsion family (Infinix/Tecno/itel — which
 * together are a very large share of the Egyptian market, this product's
 * FIRST market) it is not enough. Those skins add an out-of-AOSP
 * "autostart" allow-list, and an app that is not on it is killed on
 * screen-off or on swipe-away regardless of anything the app does. The
 * agent then looks perfectly healthy in code and is simply not running.
 *
 * No API exists to add ourselves to those lists. The only thing an app
 * can do is take the user to the right screen. That is all this class
 * does — it opens a screen, it never grants anything.
 *
 * WHY EVERY SINGLE INTENT IS WRAPPED
 * These components are internal to OEM system apps. They are renamed,
 * merged and deleted between skin versions, and on some builds they exist
 * but are not exported. Any of those cases throws
 * `ActivityNotFoundException` or `SecurityException` from
 * `startActivity`, and an uncaught one crashes the app during onboarding
 * — turning a nice-to-have step into the worst possible first-run
 * experience. Every candidate is therefore attempted defensively and, on
 * failure, we fall through to the next candidate, then to the platform's
 * own battery-optimisation screen, then to this app's settings page.
 * [openBestAvailableScreen] cannot throw.
 *
 * The component lists below are ordered newest-skin-first within each
 * vendor. They are best-effort by nature: BLOCKED, in this repository's
 * evidence vocabulary, until someone runs the APK on real hardware.
 */
class OemBackgroundRestrictionManager(private val context: Context) {

    /** Stable identifiers, also used as the Dart-side i18n key suffix. */
    object Oem {
        const val XIAOMI = "xiaomi"
        const val OPPO = "oppo"
        const val VIVO = "vivo"
        const val HUAWEI = "huawei"
        const val SAMSUNG = "samsung"
        const val TRANSSION = "transsion" // Infinix / Tecno / itel
        const val GENERIC = "generic"
    }

    /** What [openBestAvailableScreen] actually managed to open. */
    object OpenedScreen {
        const val OEM_AUTOSTART = "oem_autostart"
        const val BATTERY_OPTIMIZATION = "battery_optimization"
        const val APP_DETAILS = "app_details"
        const val NONE = "none"
    }

    /**
     * Matched against `Build.MANUFACTURER` and `Build.BRAND`, both
     * lower-cased. Brand is checked as well as manufacturer because
     * Redmi/POCO report BRAND=redmi with MANUFACTURER=Xiaomi, Realme
     * reports BRAND=realme, and Transsion devices report BRAND=Infinix
     * or TECNO with a MANUFACTURER that varies by region.
     */
    fun detectOem(): String {
        val manufacturer = Build.MANUFACTURER.orEmpty().lowercase()
        val brand = Build.BRAND.orEmpty().lowercase()
        val id = "$manufacturer $brand"
        return when {
            id.contains("xiaomi") || id.contains("redmi") || id.contains("poco") -> Oem.XIAOMI
            id.contains("oppo") || id.contains("realme") || id.contains("oneplus") -> Oem.OPPO
            id.contains("vivo") || id.contains("iqoo") -> Oem.VIVO
            id.contains("huawei") || id.contains("honor") -> Oem.HUAWEI
            id.contains("samsung") -> Oem.SAMSUNG
            id.contains("infinix") || id.contains("tecno") || id.contains("itel") ||
                id.contains("transsion") -> Oem.TRANSSION
            else -> Oem.GENERIC
        }
    }

    /**
     * Candidate autostart / background-management Activities per vendor,
     * most-likely-first. Sources: the vendors' own security-centre apps.
     */
    private fun candidatesFor(oem: String): List<ComponentName> = when (oem) {
        Oem.XIAOMI -> listOf(
            ComponentName(
                "com.miui.securitycenter",
                "com.miui.permcenter.autostart.AutoStartManagementActivity",
            ),
            ComponentName(
                "com.miui.powerkeeper",
                "com.miui.powerkeeper.ui.HiddenAppsConfigActivity",
            ),
        )
        Oem.OPPO -> listOf(
            ComponentName(
                "com.coloros.safecenter",
                "com.coloros.safecenter.permission.startup.StartupAppListActivity",
            ),
            ComponentName(
                "com.coloros.safecenter",
                "com.coloros.safecenter.startupapp.StartupAppListActivity",
            ),
            ComponentName(
                "com.oppo.safe",
                "com.oppo.safe.permission.startup.StartupAppListActivity",
            ),
            ComponentName(
                "com.coloros.oppoguardelf",
                "com.coloros.powermanager.fuelgaue.PowerUsageModelActivity",
            ),
        )
        Oem.VIVO -> listOf(
            ComponentName(
                "com.vivo.permissionmanager",
                "com.vivo.permissionmanager.activity.BgStartUpManagerActivity",
            ),
            ComponentName(
                "com.iqoo.secure",
                "com.iqoo.secure.ui.phoneoptimize.AddWhiteListActivity",
            ),
            ComponentName(
                "com.iqoo.secure",
                "com.iqoo.secure.safeguard.PurviewTabActivity",
            ),
        )
        Oem.HUAWEI -> listOf(
            ComponentName(
                "com.huawei.systemmanager",
                "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity",
            ),
            ComponentName(
                "com.huawei.systemmanager",
                "com.huawei.systemmanager.appcontrol.activity.StartupAppControlActivity",
            ),
            ComponentName(
                "com.huawei.systemmanager",
                "com.huawei.systemmanager.optimize.process.ProtectActivity",
            ),
        )
        Oem.SAMSUNG -> listOf(
            // Samsung has no autostart list; the equivalent control is
            // "Device care > Battery > Background usage limits". One UI
            // renamed the Activity between versions, hence two entries.
            ComponentName(
                "com.samsung.android.lool",
                "com.samsung.android.sm.battery.ui.BatteryActivity",
            ),
            ComponentName(
                "com.samsung.android.lool",
                "com.samsung.android.sm.ui.battery.BatteryActivity",
            ),
        )
        Oem.TRANSSION -> listOf(
            // Infinix / Tecno / itel — HiOS, XOS and itel OS all ship
            // "PhoneMaster"/"Power Master" with an autostart list. These
            // two components cover the builds seen most often in Egypt.
            ComponentName(
                "com.transsion.phonemaster",
                "com.cyin.himgr.autostart.AutoStartActivity",
            ),
            ComponentName(
                "com.transsion.phonemanager",
                "com.itel.autobootmanager.activity.AutoBootMgrActivity",
            ),
        )
        else -> emptyList()
    }

    /**
     * True when at least one vendor Activity for this device resolves.
     *
     * NOTE on Android 11+ package visibility: `resolveActivity` can return
     * null for a package this app is not allowed to see. The relevant
     * vendor packages are declared in `<queries>` in AndroidManifest.xml
     * so that this stays a meaningful check — but the result is treated
     * as a HINT only. [openBestAvailableScreen] always tries the
     * `startActivity` regardless, because a false negative here would
     * hide a screen that actually exists.
     */
    fun hasOemScreen(): Boolean = candidatesFor(detectOem()).any { resolves(it) }

    fun isBatteryOptimizationExempted(): Boolean {
        val powerManager = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
            ?: return false
        return try {
            powerManager.isIgnoringBatteryOptimizations(context.packageName)
        } catch (t: Throwable) {
            false
        }
    }

    fun info(): Map<String, Any> {
        val oem = detectOem()
        return mapOf(
            "manufacturer" to Build.MANUFACTURER.orEmpty(),
            "brand" to Build.BRAND.orEmpty(),
            "oemKey" to oem,
            "hasOemIntent" to hasOemScreen(),
            "batteryExempt" to isBatteryOptimizationExempted(),
        )
    }

    /**
     * Tries, in order: every vendor candidate, then the platform battery
     * optimisation list, then this app's own settings page. Returns the
     * [OpenedScreen] id of whatever opened, or [OpenedScreen.NONE].
     *
     * Never throws. That guarantee is the entire point of this method:
     * onboarding must survive a device whose vendor screens have all been
     * renamed.
     */
    fun openBestAvailableScreen(): String {
        for (component in candidatesFor(detectOem())) {
            if (tryStart(Intent().setComponent(component))) {
                return OpenedScreen.OEM_AUTOSTART
            }
        }

        // Platform fallback #1: the OS-level battery optimisation list.
        // ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS (the LIST) is used
        // rather than ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS (the
        // dialog) because the dialog is already its own onboarding item,
        // and showing the same system dialog twice for two different
        // reasons trains the user to dismiss it.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M &&
            tryStart(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
        ) {
            return OpenedScreen.BATTERY_OPTIMIZATION
        }

        // Platform fallback #2: this app's own details page. Always
        // present on any Android build, so this is the true floor.
        val details = Intent(
            Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
            Uri.parse("package:${context.packageName}"),
        )
        if (tryStart(details)) return OpenedScreen.APP_DETAILS

        return OpenedScreen.NONE
    }

    private fun resolves(component: ComponentName): Boolean = try {
        context.packageManager.resolveActivity(Intent().setComponent(component), 0) != null
    } catch (t: Throwable) {
        false
    }

    /**
     * The one place `startActivity` is called for a component this app
     * does not own. Catches [Throwable], not just
     * [ActivityNotFoundException], on purpose: OEM system apps have also
     * been observed throwing `SecurityException` (activity present but
     * not exported) and `IllegalArgumentException` from their own
     * onCreate. Any of them must degrade to "try the next candidate",
     * never to a crash on a child's phone.
     */
    private fun tryStart(intent: Intent): Boolean = try {
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
        true
    } catch (e: ActivityNotFoundException) {
        false
    } catch (t: Throwable) {
        false
    }
}
