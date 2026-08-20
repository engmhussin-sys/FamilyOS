package com.aifamilycoach.child_app.core

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.ActivityCompat

/**
 * G18 — the POST_NOTIFICATIONS runtime request, and the ONLY place in this app
 * that asks for it.
 *
 * WHY A CLASS AND NOT FOUR LINES IN MainActivity
 * `ActivityCompat.requestPermissions` is asynchronous: the answer arrives on
 * `Activity.onRequestPermissionsResult`, long after the MethodChannel call that
 * started it returned. Bridging those two needs state (the pending
 * MethodChannel reply) and that state has three failure modes, each of which is
 * a real bug in shipped apps:
 *
 *   1. REPLYING TWICE to one MethodChannel result — Flutter throws
 *      IllegalStateException and, on a release build, the crash is attributed
 *      to whatever ran next.
 *   2. NEVER REPLYING — the Dart `await` hangs forever, so the UI sits on a
 *      spinner with no error, which is worse than a denial.
 *   3. A SECOND request arriving while the first dialog is still open, which
 *      overwrites the pending reply and guarantees (2) for the first caller.
 *
 * All three are handled here, once, instead of being re-derived at each call
 * site. [pending] is the single piece of state and every path that sets it also
 * has a path that clears it.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: decide when to ask. That is a product
 * decision (ask AFTER the value has been explained, never on cold start) and it
 * lives in Dart — NotificationPrimingScreen shows the explanation and only then
 * calls this. A native class that decided its own timing would put policy in
 * the one layer that cannot be unit-tested here.
 */
object NotificationPermissionRequester {

    /**
     * Chosen high and app-specific to avoid colliding with the request codes
     * Flutter plugins use; `onRequestPermissionsResult` dispatches on it, so a
     * collision would make two features answer each other's dialogs.
     */
    const val REQUEST_CODE = 4711

    private var pending: ((String) -> Unit)? = null

    /**
     * Asks for POST_NOTIFICATIONS, invoking [onOutcome] exactly once with one
     * of [AgentChannel.NotificationPermissionOutcome].
     *
     * Returns without showing a dialog — and answers immediately — when the
     * permission cannot or need not be requested, so the caller never waits on
     * a dialog that was never going to appear.
     */
    fun request(activity: Activity, onOutcome: (String) -> Unit) {
        // Below API 33 POST_NOTIFICATIONS is granted at install time. Asking
        // would show nothing and answer nothing.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            onOutcome(AgentChannel.NotificationPermissionOutcome.NOT_REQUIRED)
            return
        }

        val alreadyGranted = ActivityCompat.checkSelfPermission(
            activity,
            Manifest.permission.POST_NOTIFICATIONS,
        ) == PackageManager.PERMISSION_GRANTED
        if (alreadyGranted) {
            onOutcome(AgentChannel.NotificationPermissionOutcome.ALREADY_GRANTED)
            return
        }

        // Failure mode 3. The in-flight caller keeps the dialog; the newcomer
        // is answered immediately rather than left hanging, and its answer is
        // the honest current state (not granted, ask again later).
        if (pending != null) {
            onOutcome(AgentChannel.NotificationPermissionOutcome.DENIED)
            return
        }

        pending = onOutcome
        try {
            ActivityCompat.requestPermissions(
                activity,
                arrayOf(Manifest.permission.POST_NOTIFICATIONS),
                REQUEST_CODE,
            )
        } catch (_: Throwable) {
            // If the request could not even be dispatched, answer NOW — failure
            // mode 2 (never replying) is not an acceptable outcome of an
            // exception, and the Dart side would await forever.
            pending = null
            onOutcome(AgentChannel.NotificationPermissionOutcome.DENIED)
        }
    }

    /**
     * Called from `MainActivity.onRequestPermissionsResult`. Returns true when
     * this class consumed the result, so the Activity can tell whether to pass
     * it on to Flutter's own plugin dispatcher.
     *
     * DISTINGUISHING "declined once" FROM "declined for good":
     * `shouldShowRequestPermissionRationale` is the only signal Android gives,
     * and it is only meaningful AFTER a denial — before the first request it is
     * also false. Read at this point it is exact: true means Android will show
     * the dialog again, false means it never will, and the UI must offer the
     * settings route instead of a button that silently does nothing.
     */
    fun onRequestPermissionsResult(
        activity: Activity,
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ): Boolean {
        if (requestCode != REQUEST_CODE) return false

        val callback = pending
        pending = null
        if (callback == null) return true // already answered; never reply twice

        val index = permissions.indexOf(Manifest.permission.POST_NOTIFICATIONS)
        val granted = index >= 0 &&
            index < grantResults.size &&
            grantResults[index] == PackageManager.PERMISSION_GRANTED

        if (granted) {
            callback(AgentChannel.NotificationPermissionOutcome.GRANTED)
            return true
        }

        // An EMPTY grantResults means the request was cancelled (the dialog was
        // dismissed without a choice, or interrupted). That is not a denial and
        // must not be reported as a permanent one.
        if (grantResults.isEmpty()) {
            callback(AgentChannel.NotificationPermissionOutcome.DENIED)
            return true
        }

        val canAskAgain = ActivityCompat.shouldShowRequestPermissionRationale(
            activity,
            Manifest.permission.POST_NOTIFICATIONS,
        )
        callback(
            if (canAskAgain) {
                AgentChannel.NotificationPermissionOutcome.DENIED
            } else {
                AgentChannel.NotificationPermissionOutcome.PERMANENTLY_DENIED
            },
        )
        return true
    }

    /**
     * Clears any pending reply. Called when the Activity is destroyed: a
     * MethodChannel reply into a dead engine is a crash, and a callback held
     * across a configuration change leaks the old Activity.
     */
    fun reset() {
        pending = null
    }
}
