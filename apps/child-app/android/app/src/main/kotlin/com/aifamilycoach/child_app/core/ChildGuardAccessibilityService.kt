package com.aifamilycoach.child_app.core

import android.accessibilityservice.AccessibilityService
import android.content.Intent
import android.view.accessibility.AccessibilityEvent

/**
 * THE component this entire project's caution has been about. Read
 * child-runtime-engine.md and sprint4-partial-backend-permissions-capabilities.md
 * §4 before touching this file — this is the code whose subtle bugs fail
 * SILENTLY (parent sees "protected," child isn't).
 *
 * Scope, deliberately minimal: listen for foreground-app changes
 * (TYPE_WINDOW_STATE_CHANGED), evaluate against the locally-cached
 * policy (NativePolicyStore + PolicyEnforcer, both pure/testable-in-
 * isolation), show/hide the overlay accordingly. NOT included:
 * screen-content reading, text capture, any accessibility node
 * inspection beyond the package name of the foreground window — this
 * service does not and must not read what's ON the screen, only WHICH
 * APP is in the foreground.
 *
 * Requires `apps/child-app/android/app/src/main/res/xml/accessibility_service_config.xml`
 * and the corresponding manifest `<service>` entry (both included in
 * this delivery) — without both, Android will not offer this service in
 * Settings > Accessibility at all, and `isAccessibilityServiceEnabled`
 * will correctly, harmlessly report false forever.
 */
class ChildGuardAccessibilityService : AccessibilityService() {

    private lateinit var policyStore: NativePolicyStore
    private lateinit var overlayManager: OverlayManager
    private var lastEvaluatedPackage: String? = null

    override fun onServiceConnected() {
        super.onServiceConnected()
        policyStore = NativePolicyStore(applicationContext)
        overlayManager = OverlayManager(applicationContext)
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event?.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) return

        val packageName = event.packageName?.toString() ?: return
        if (packageName == applicationContext.packageName) return // never block ourselves
        if (packageName == lastEvaluatedPackage) return // avoid re-evaluating on every sub-event of the same app
        lastEvaluatedPackage = packageName

        val policy = try {
            policyStore.load()
        } catch (e: Exception) {
            NativePolicyStore.DEFAULT_OFFLINE_POLICY
        }

        // Real daily usage — closes the gap from this feature's first
        // draft, where this was hardcoded to 0 (silently disabling the
        // daily-limit rule while bedtime/blocked-package rules worked).
        // Requires Usage Access (checked at the call site: if it's not
        // granted, queryUsageStats returns an empty list and this
        // safely reports 0 — the daily-limit rule is inert until the
        // parent/child grants that permission, not a crash).
        val minutesUsedToday = DailyUsageTracker.getMinutesUsedToday(applicationContext)

        val result = PolicyEnforcer.evaluate(packageName, policy, minutesUsedToday)

        if (result.decision == EnforcementDecision.BLOCK) {
            overlayManager.show(result.reason) { goHome() }
        } else {
            overlayManager.hide()
        }
    }

    override fun onInterrupt() {
        overlayManager.hide()
    }

    override fun onDestroy() {
        overlayManager.hide()
        super.onDestroy()
    }

    private fun goHome() {
        val homeIntent = Intent(Intent.ACTION_MAIN).apply {
            addCategory(Intent.CATEGORY_HOME)
            flags = Intent.FLAG_ACTIVITY_NEW_TASK
        }
        startActivity(homeIntent)
    }
}
