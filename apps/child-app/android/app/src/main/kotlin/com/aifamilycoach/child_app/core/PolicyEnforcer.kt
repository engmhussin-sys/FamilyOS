package com.aifamilycoach.child_app.core

import com.aifamilycoach.child_app.R
import java.util.Calendar

enum class EnforcementDecision { ALLOW, BLOCK }

/**
 * @param decision  what the enforcement loop should do.
 * @param reasonRes STRING RESOURCE ID of the child-facing sentence. It is
 *   a resource id, never a literal, so the copy is localised (Arabic first
 *   — CONTEXT §1) and so the non-punitive tone rule (CONTEXT §3 principle
 *   7) is enforced in one reviewable place, `res/values*/strings.xml`,
 *   instead of being scattered across Kotlin string literals.
 * @param diagnostic SHORT, STABLE, ENGLISH tag for logs, telemetry and
 *   tests only. Never rendered to a child. Kept separate on purpose: the
 *   thing the child reads and the thing an engineer greps for have
 *   different audiences and must be allowed to diverge.
 */
data class EnforcementResult(
    val decision: EnforcementDecision,
    val reasonRes: Int,
    val diagnostic: String,
)

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
            return EnforcementResult(
                EnforcementDecision.BLOCK,
                R.string.enforcement_reason_not_in_plan,
                "not_in_plan",
            )
        }

        if (isWithinBedtime(policy.bedtimeStart, policy.bedtimeEnd, now)) {
            return EnforcementResult(
                EnforcementDecision.BLOCK,
                R.string.enforcement_reason_bedtime,
                "bedtime",
            )
        }

        val limit = policy.dailyLimitMinutes
        if (limit != null && minutesUsedToday >= limit) {
            return EnforcementResult(
                EnforcementDecision.BLOCK,
                R.string.enforcement_reason_daily_limit,
                "daily_limit",
            )
        }

        return EnforcementResult(
            EnforcementDecision.ALLOW,
            R.string.enforcement_reason_within_policy,
            "within_policy",
        )
    }

    private fun isWithinBedtime(start: String?, end: String?, now: Calendar): Boolean {
        if (start == null || end == null) return false

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
