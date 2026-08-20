package com.aifamilycoach.child_app.core

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.provider.Settings
import androidx.core.app.NotificationCompat
import androidx.core.app.PendingIntentCompat
import com.aifamilycoach.child_app.R

/**
 * AWAITING REAL DEVICE VALIDATION. Distinct from
 * ChildGuardForegroundService's own low-importance persistent status
 * notification — these are actionable alerts (e.g. "Accessibility was
 * turned off"), IMPORTANCE_HIGH, tap-to-fix via a deep link straight
 * into the relevant Settings screen.
 */
class RuntimeAlertNotifier(private val context: Context) {

    companion object {
        private const val CHANNEL_ID = "afdc_runtime_alerts"
        private const val ALERT_NOTIFICATION_ID = 2001
    }

    init {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                context.getString(R.string.notif_channel_protection_alerts),
                NotificationManager.IMPORTANCE_HIGH,
            )
            val manager = context.getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(channel)
        }
    }

    fun notifyAccessibilityDisabled() {
        val settingsIntent = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK
        }
        val pendingIntent = PendingIntentCompat.getActivity(
            context, 0, settingsIntent, 0, false,
        )

        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setContentTitle(context.getString(R.string.alert_protection_off_title))
            .setContentText(context.getString(R.string.alert_protection_off_text))
            .setSmallIcon(android.R.drawable.stat_sys_warning)
            .setContentIntent(pendingIntent)
            .setAutoCancel(true)
            .build()

        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.notify(ALERT_NOTIFICATION_ID, notification)
    }

    fun notifyProtectionRestored() {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.cancel(ALERT_NOTIFICATION_ID)
    }
}
