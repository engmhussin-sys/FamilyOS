package com.aifamilycoach.child_app.core

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import com.aifamilycoach.child_app.R

/**
 * Sprint 5's Foreground Runtime + Runtime Watchdog, combined —
 * deliberately one class, not two: a watchdog with nothing to watch
 * over on its own needs a host process, and a foreground service with
 * no watchdog duty is just a notification. Its one real job beyond the
 * mandatory persistent notification: periodically check whether
 * `ChildGuardAccessibilityService` is still enabled
 * (`PermissionManager.isChildGuardAccessibilityServiceEnabled`, already built)
 * and, if not, escalate via the notification — it cannot re-enable
 * Accessibility itself (no API allows that; only the user can, in
 * Settings) but it CAN make sure the parent's device finds out.
 *
 * Honest limitation: this does NOT run a native heartbeat/telemetry
 * network loop — that stays Flutter-owned (`HeartbeatService`,
 * Sprint 3/4). If the Flutter engine isn't running (app fully killed,
 * not just backgrounded), heartbeats stop even though this service and
 * `ChildGuardAccessibilityService` keep enforcing locally from the
 * cached policy. Building a duplicate native HTTP/auth stack to close
 * that gap is real, separate work — not attempted here under time
 * pressure just to claim full coverage.
 */
class ChildGuardForegroundService : Service() {

    private val handler = Handler(Looper.getMainLooper())
    private lateinit var permissionManager: PermissionManager
    private var watchdogRunnable: Runnable? = null

    companion object {
        private const val NOTIFICATION_CHANNEL_ID = "afdc_runtime_status"
        private const val NOTIFICATION_ID = 1001
        private const val WATCHDOG_INTERVAL_MS = 60_000L
    }

    override fun onCreate() {
        super.onCreate()
        permissionManager = PermissionManager(applicationContext)
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(NOTIFICATION_ID, buildNotification(isHealthy = true))
        startWatchdog()
        // START_STICKY: ask the system to recreate this service if it's
        // killed under memory pressure — best-effort, not a guarantee on
        // every OEM (child-agent-android-enforcement.md §7's already-
        // documented limitation, unchanged by this addition).
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        watchdogRunnable?.let { handler.removeCallbacks(it) }
        super.onDestroy()
    }

    private fun startWatchdog() {
        val runnable = object : Runnable {
            override fun run() {
                val accessibilityEnabled =
                    permissionManager.isChildGuardAccessibilityServiceEnabled()
                val notification = buildNotification(isHealthy = accessibilityEnabled)
                val notificationManager =
                    getSystemService(NOTIFICATION_SERVICE) as NotificationManager
                notificationManager.notify(NOTIFICATION_ID, notification)

                handler.postDelayed(this, WATCHDOG_INTERVAL_MS)
            }
        }
        watchdogRunnable = runnable
        handler.post(runnable)
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val channel = NotificationChannel(
            NOTIFICATION_CHANNEL_ID,
            getString(R.string.notif_channel_protection_status),
            NotificationManager.IMPORTANCE_LOW, // low, not high — this is a status indicator, not an alert
        )
        val notificationManager = getSystemService(NotificationManager::class.java)
        notificationManager.createNotificationChannel(channel)
    }

    private fun buildNotification(isHealthy: Boolean) =
        NotificationCompat.Builder(this, NOTIFICATION_CHANNEL_ID)
            // Localised (Arabic first) and non-technical: this notification
            // sits permanently on a child's device, so it must not read like
            // a system error log. The term "Accessibility Service" is gone
            // from the child-facing copy — it means nothing to a 9-year-old.
            .setContentTitle(
                getString(
                    if (isHealthy) R.string.notif_protection_active_title
                    else R.string.notif_protection_attention_title,
                ),
            )
            .setContentText(
                getString(
                    if (isHealthy) R.string.notif_protection_active_text
                    else R.string.notif_protection_attention_text,
                ),
            )
            .setSmallIcon(android.R.drawable.ic_lock_idle_lock) // placeholder — replace with a real app icon asset
            .setOngoing(true)
            .build()
}
