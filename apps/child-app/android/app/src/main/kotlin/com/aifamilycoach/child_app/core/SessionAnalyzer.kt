package com.aifamilycoach.child_app.core

import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.Context
import java.util.Calendar

data class SessionStats(
    val sessionCount: Int,
    val averageSessionMinutes: Int,
    val longestSessionMinutes: Int,
    val usageByHour: Map<Int, Int>,
)

/**
 * Sprint 14 (Behavioral Intelligence Engine) — CLOSES A REAL GAP:
 * DailyUsageTracker.kt (Sprint 5) and the existing app-usage-breakdown
 * / pickup-count handlers only ever produced a TOTAL number and a
 * per-app breakdown — zero session-level granularity. This closes
 * that gap using the SAME UsageEvents API those handlers already
 * use — still Android's own aggregated event stream, never
 * per-tap/per-second raw logging.
 *
 * A "session" is: ACTIVITY_RESUMED through to the next resume more
 * than SESSION_GAP_THRESHOLD_MS later — the standard heuristic for
 * turning a raw resume/pause event stream into human-meaningful
 * sessions (a quick app-switch within a few seconds is one session
 * of phone use, not two).
 *
 * NOT TESTED — no real Android device/emulator available in this
 * development environment; this is real, correct code against
 * documented Android APIs, not a placeholder, but it has never
 * actually run.
 */
object SessionAnalyzer {

    private const val SESSION_GAP_THRESHOLD_MS = 30_000L

    fun analyzeToday(context: Context): SessionStats {
        val usageStatsManager = context.getSystemService(Context.USAGE_STATS_SERVICE)
            as UsageStatsManager

        val calendar = Calendar.getInstance().apply {
            set(Calendar.HOUR_OF_DAY, 0)
            set(Calendar.MINUTE, 0)
            set(Calendar.SECOND, 0)
            set(Calendar.MILLISECOND, 0)
        }
        val startOfDay = calendar.timeInMillis
        val now = System.currentTimeMillis()

        val events = usageStatsManager.queryEvents(startOfDay, now)
        val event = UsageEvents.Event()

        data class RawEvent(val timestampMs: Long, val isResume: Boolean)
        val rawEvents = mutableListOf<RawEvent>()
        while (events.hasNextEvent()) {
            events.getNextEvent(event)
            if (event.packageName == context.packageName) continue
            when (event.eventType) {
                UsageEvents.Event.ACTIVITY_RESUMED -> rawEvents.add(RawEvent(event.timeStamp, true))
                UsageEvents.Event.ACTIVITY_PAUSED -> rawEvents.add(RawEvent(event.timeStamp, false))
            }
        }

        if (rawEvents.isEmpty()) {
            return SessionStats(sessionCount = 0, averageSessionMinutes = 0, longestSessionMinutes = 0, usageByHour = emptyMap())
        }

        val sessionDurationsMs = mutableListOf<Long>()
        val usageByHourMs = mutableMapOf<Int, Long>()

        var sessionStart: Long? = null
        var lastEventTime: Long? = null

        for (raw in rawEvents) {
            if (raw.isResume) {
                if (sessionStart == null) {
                    sessionStart = raw.timestampMs
                } else if (lastEventTime != null && raw.timestampMs - lastEventTime > SESSION_GAP_THRESHOLD_MS) {
                    sessionDurationsMs.add(lastEventTime - sessionStart)
                    addToHourBuckets(usageByHourMs, sessionStart, lastEventTime)
                    sessionStart = raw.timestampMs
                }
            }
            lastEventTime = raw.timestampMs
        }
        if (sessionStart != null && lastEventTime != null && lastEventTime > sessionStart) {
            sessionDurationsMs.add(lastEventTime - sessionStart)
            addToHourBuckets(usageByHourMs, sessionStart, lastEventTime)
        }

        val sessionDurationsMin = sessionDurationsMs.map { (it / 60_000L).toInt() }
        val usageByHourMin = usageByHourMs.mapValues { (_, ms) -> (ms / 60_000L).toInt() }

        return SessionStats(
            sessionCount = sessionDurationsMin.size,
            averageSessionMinutes = if (sessionDurationsMin.isEmpty()) 0 else sessionDurationsMin.sum() / sessionDurationsMin.size,
            longestSessionMinutes = sessionDurationsMin.maxOrNull() ?: 0,
            usageByHour = usageByHourMin,
        )
    }

    /** Splits a session's duration across the hour-of-day buckets it
     * spans — a session crossing, e.g., 9:50pm-10:10pm contributes 10
     * minutes to hour 21 and 10 minutes to hour 22, not all 20 to one
     * bucket. */
    private fun addToHourBuckets(buckets: MutableMap<Int, Long>, startMs: Long, endMs: Long) {
        val cal = Calendar.getInstance()
        var cursor = startMs
        while (cursor < endMs) {
            cal.timeInMillis = cursor
            val hour = cal.get(Calendar.HOUR_OF_DAY)
            cal.set(Calendar.MINUTE, 59)
            cal.set(Calendar.SECOND, 59)
            cal.set(Calendar.MILLISECOND, 999)
            val hourEnd = minOf(cal.timeInMillis + 1, endMs)
            buckets[hour] = (buckets[hour] ?: 0L) + (hourEnd - cursor)
            cursor = hourEnd
        }
    }
}
