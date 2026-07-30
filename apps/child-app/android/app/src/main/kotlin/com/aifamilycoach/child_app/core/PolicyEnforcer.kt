package com.aifamilycoach.child_app.core

import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Locale

enum class EnforcementDecision { ALLOW, BLOCK }

data class EnforcementResult(val decision: EnforcementDecision, val reason: String)

/**
 * The native mirror of `plugins/local_ai/application/deterministic_rule_engine.dart`'s
 * `ILocalRuleEngine` — deliberately duplicated logic, not shared code,
 * since Kotlin and Dart can't share a function body. Kept as simple,
 * auditable if/else on purpose (matches the Dart original's own
 * reasoning: this is the ONE thing in the Local AI Runtime family that's
 * actually implemented, everything else stays a declared contract).
 * Pure function — no I/O, easy to reason about and to unit test if a
 * Kotlin test harness is ever added to this project.
 */
object PolicyEnforcer {

    fun evaluate(
        packageName: String,
        policy: NativePolicy,
        minutesUsedToday: Int,
        now: Calendar = Calendar.getInstance(),
    ): EnforcementResult {
        if (policy.blockedPackages.contains(packageName)) {
            return EnforcementResult(EnforcementDecision.BLOCK, "App is on the blocked list")
        }

        if (isWithinBedtime(policy.bedtimeStart, policy.bedtimeEnd, now)) {
            return EnforcementResult(EnforcementDecision.BLOCK, "Bedtime hours")
        }

        val limit = policy.dailyLimitMinutes
        if (limit != null && minutesUsedToday >= limit) {
            return EnforcementResult(EnforcementDecision.BLOCK, "Daily screen time limit reached")
        }

        return EnforcementResult(EnforcementDecision.ALLOW, "Within policy")
    }

    private fun isWithinBedtime(start: String?, end: String?, now: Calendar): Boolean {
        if (start == null || end == null) return false

        val format = SimpleDateFormat("HH:mm", Locale.US)
        val startParts = start.split(":").map { it.toInt() }
        val endParts = end.split(":").map { it.toInt() }

        val nowMinutes = now.get(Calendar.HOUR_OF_DAY) * 60 + now.get(Calendar.MINUTE)
        val startMinutes = startParts[0] * 60 + startParts[1]
        val endMinutes = endParts[0] * 60 + endParts[1]

        return if (startMinutes <= endMinutes) {
            // Same-day window, e.g. 13:00-15:00.
            nowMinutes in startMinutes until endMinutes
        } else {
            // Overnight window, e.g. 21:00-07:00 — the common bedtime case.
            nowMinutes >= startMinutes || nowMinutes < endMinutes
        }
    }
}
