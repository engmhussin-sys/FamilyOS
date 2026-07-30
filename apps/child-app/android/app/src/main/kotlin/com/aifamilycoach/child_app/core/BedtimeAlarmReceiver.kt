package com.aifamilycoach.child_app.core

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * AWAITING REAL DEVICE VALIDATION. Fired by AlarmManager at the exact
 * bedtime boundary. Forces an immediate overlay check against the
 * foreground app right now, rather than waiting for the next
 * `TYPE_WINDOW_STATE_CHANGED` event (which won't fire again until the
 * child switches apps — by design of how Accessibility events work).
 */
class BedtimeAlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val policyStore = NativePolicyStore(context)
        val policy = policyStore.load()

        // No direct way to query "what app is currently foreground"
        // outside of an active AccessibilityEvent or UsageStatsManager's
        // own (less real-time) query — using the latter here since this
        // is a one-off check, not a continuous stream.
        val minutesUsedToday = DailyUsageTracker.getMinutesUsedToday(context)
        val result = PolicyEnforcer.evaluate(
            packageName = "", // bedtime rule doesn't depend on package name — always applies
            policy = policy,
            minutesUsedToday = minutesUsedToday,
        )

        if (result.decision == EnforcementDecision.BLOCK) {
            OverlayManager(context).show(result.reason) {
                val homeIntent = Intent(Intent.ACTION_MAIN).apply {
                    addCategory(Intent.CATEGORY_HOME)
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK
                }
                context.startActivity(homeIntent)
            }
        }

        // Reschedule for the following day.
        RuntimeWatchdogScheduler.scheduleBedtimeAlarm(context, policy.bedtimeStart)
    }
}
