package com.aifamilycoach.child_app.core

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import java.util.Calendar
import java.util.concurrent.TimeUnit

/**
 * AWAITING REAL DEVICE VALIDATION. Single place both Boot Recovery
 * (BootReceiver) and the app's own startup path (called from
 * MainActivity's `startEnforcementService` handler) call into — avoids
 * duplicating the WorkManager/AlarmManager setup in two places.
 */
object RuntimeWatchdogScheduler {
    private const val WATCHDOG_WORK_NAME = "afdc_runtime_watchdog"
    private const val BEDTIME_ALARM_REQUEST_CODE = 3001

    fun scheduleWatchdog(context: Context) {
        val request = PeriodicWorkRequestBuilder<RuntimeWatchdogWorker>(15, TimeUnit.MINUTES).build()
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(
            WATCHDOG_WORK_NAME,
            ExistingPeriodicWorkPolicy.KEEP, // don't reset the schedule if already running
            request,
        )
    }

    /**
     * AlarmManager integration — schedules an exact alarm for the
     * cached policy's bedtime start, so a bedtime transition is caught
     * even if no `TYPE_WINDOW_STATE_CHANGED` event happens to fire right
     * at that moment (the child could already be mid-session in an
     * otherwise-allowed app when bedtime begins).
     */
    fun scheduleBedtimeAlarm(context: Context, bedtimeStart: String?) {
        val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val intent = Intent(context, BedtimeAlarmReceiver::class.java)
        val pendingIntent = PendingIntent.getBroadcast(
            context,
            BEDTIME_ALARM_REQUEST_CODE,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        if (bedtimeStart == null) {
            alarmManager.cancel(pendingIntent)
            return
        }

        val parts = bedtimeStart.split(":").map { it.toInt() }
        val triggerTime = Calendar.getInstance().apply {
            set(Calendar.HOUR_OF_DAY, parts[0])
            set(Calendar.MINUTE, parts[1])
            set(Calendar.SECOND, 0)
            if (before(Calendar.getInstance())) add(Calendar.DAY_OF_MONTH, 1) // if already past today, schedule tomorrow
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !alarmManager.canScheduleExactAlarms()) {
            // Android 12+ requires the user to explicitly grant exact-alarm
            // scheduling. Falls back to an inexact alarm rather than
            // throwing — bedtime enforcement degrades to "approximately on
            // time" instead of failing outright.
            alarmManager.set(AlarmManager.RTC_WAKEUP, triggerTime.timeInMillis, pendingIntent)
            return
        }

        alarmManager.setExactAndAllowWhileIdle(
            AlarmManager.RTC_WAKEUP,
            triggerTime.timeInMillis,
            pendingIntent,
        )
    }
}
