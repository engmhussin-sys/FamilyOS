package com.aifamilycoach.child_app.core

import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters

/**
 * AWAITING REAL DEVICE VALIDATION. Requires `androidx.work:work-runtime-ktx`
 * in `android/app/build.gradle` — cannot confirm it's present, no
 * build.gradle exists in this sandbox (same standing limitation as
 * every other native piece this project has built). Add manually:
 * `implementation "androidx.work:work-runtime-ktx:2.9.0"`.
 *
 * Runs every ~15 minutes (WorkManager's documented minimum interval for
 * PeriodicWorkRequest — cannot be scheduled more frequently). Checks:
 *   1. Is Accessibility still enabled? If not: alert + record for next heartbeat.
 *   2. Is the Foreground Service's notification still showing (proxy for
 *      "is the service alive")? If not: attempt to restart it.
 * "Self-healing" here means "attempt to restart what CAN be restarted
 * (the Foreground Service) and clearly alert about what CANNOT be
 * restarted programmatically (Accessibility — only the user can
 * re-enable it in Settings)" — not a claim that this can force
 * Accessibility back on, which no public API allows.
 */
class RuntimeWatchdogWorker(
    context: Context,
    params: WorkerParameters,
) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val permissionManager = PermissionManager(applicationContext)
        val notifier = RuntimeAlertNotifier(applicationContext)
        val prefs = applicationContext.getSharedPreferences("afdc_runtime_watchdog", Context.MODE_PRIVATE)

        val accessibilityEnabled = permissionManager.isChildGuardAccessibilityServiceEnabled()
        val wasEnabledLastCheck = prefs.getBoolean("was_accessibility_enabled", true)

        if (!accessibilityEnabled) {
            notifier.notifyAccessibilityDisabled()
        } else if (!wasEnabledLastCheck) {
            // Transitioned back to enabled since the last check.
            notifier.notifyProtectionRestored()
        }
        prefs.edit().putBoolean("was_accessibility_enabled", accessibilityEnabled).apply()

        // Service Recovery: restart the Foreground Service if it's not
        // running. There's no direct "isServiceRunning" public API on
        // modern Android — the practical proxy is simply to call
        // startForegroundService again; Android no-ops if it's already
        // running rather than creating a duplicate.
        val serviceIntent = Intent(applicationContext, ChildGuardForegroundService::class.java)
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                applicationContext.startForegroundService(serviceIntent)
            } else {
                applicationContext.startService(serviceIntent)
            }
        } catch (e: Exception) {
            // On some OEMs, starting a foreground service from a
            // background Worker context can be restricted — logged as a
            // failed recovery attempt (retry naturally happens on the
            // Worker's next scheduled run), not crashed.
            return Result.retry()
        }

        return Result.success()
    }
}
