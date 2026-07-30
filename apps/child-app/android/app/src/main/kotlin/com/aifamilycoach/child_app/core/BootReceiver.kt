package com.aifamilycoach.child_app.core

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build

/**
 * Requires `RECEIVE_BOOT_COMPLETED` (added to AndroidManifest.xml in
 * this delivery). `ChildGuardAccessibilityService` is restarted by the
 * OS automatically once re-enabled in Settings (that's how
 * AccessibilityServices work) — this receiver's job is specifically to
 * restart `ChildGuardForegroundService`, which does NOT auto-restart on
 * boot without this.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return

        val serviceIntent = Intent(context, ChildGuardForegroundService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(serviceIntent)
        } else {
            context.startService(serviceIntent)
        }

        // Sprint 6: Boot Recovery also re-establishes the Watchdog and
        // the bedtime alarm — both are lost on reboot (WorkManager
        // periodic work generally survives reboot, but re-enqueuing here
        // is cheap and removes any doubt; AlarmManager alarms are NOT
        // persisted across reboot and MUST be rescheduled here).
        RuntimeWatchdogScheduler.scheduleWatchdog(context)
        val policy = NativePolicyStore(context).load()
        RuntimeWatchdogScheduler.scheduleBedtimeAlarm(context, policy.bedtimeStart)
    }
}
