package com.aifamilycoach.child_app.core

import android.app.usage.UsageStatsManager
import android.content.Context
import java.util.Calendar

/**
 * Closes the gap flagged in `ChildGuardAccessibilityService`'s previous
 * draft (`minutesUsedToday` was hardcoded to 0, silently disabling the
 * daily-limit rule). Read-only — requires Usage Access, already checked
 * by `PermissionManager.isUsageAccessGranted()` before this is called.
 *
 * Honest limitation: `UsageStatsManager.INTERVAL_DAILY` buckets are
 * documented by Android to not always align exactly to local midnight
 * on every OEM/API level — this is a known platform quirk, not a bug in
 * this code. For a parental-control daily limit (not billing or any
 * exact-accounting use case), this precision is acceptable; flagged
 * here rather than presented as exact.
 */
object DailyUsageTracker {

    fun getMinutesUsedToday(context: Context): Int {
        val usageStatsManager =
            context.getSystemService(Context.USAGE_STATS_SERVICE) as UsageStatsManager

        val calendar = Calendar.getInstance().apply {
            set(Calendar.HOUR_OF_DAY, 0)
            set(Calendar.MINUTE, 0)
            set(Calendar.SECOND, 0)
            set(Calendar.MILLISECOND, 0)
        }
        val startOfDay = calendar.timeInMillis
        val now = System.currentTimeMillis()

        val stats = usageStatsManager.queryUsageStats(
            UsageStatsManager.INTERVAL_DAILY,
            startOfDay,
            now,
        ) ?: return 0

        val totalForegroundMs = stats
            .filter { it.packageName != context.packageName } // never count our own app
            .sumOf { it.totalTimeInForeground }

        return (totalForegroundMs / 60_000L).toInt()
    }
}
