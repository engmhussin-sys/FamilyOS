package com.aifamilycoach.child_app.core

import android.content.Context
import android.graphics.Color
import android.graphics.PixelFormat
import android.os.Build
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import com.aifamilycoach.child_app.R

/**
 * The actual blocking screen. Uses `TYPE_APPLICATION_OVERLAY`
 * (API 26+, this project's minSdkVersion per the original Android
 * enforcement ADR) — requires `SYSTEM_ALERT_WINDOW`, granted via
 * `PermissionManager.requestOverlayPermission()` (already built,
 * Sprint 4 Track A).
 *
 * Honest limitation, stated directly: this overlay covers the screen
 * visually but does NOT prevent the underlying blocked app from
 * continuing to run or receiving input behind it — true "cannot open"
 * blocking needs Device Owner mode (child-agent-android-enforcement.md
 * §7's Multi-Distribution ADR, Enterprise variant only). The "Go Home"
 * button below is what actually removes the child from the blocked
 * app's foreground — the overlay's real job is to interrupt and redirect,
 * not to sandbox.
 */
class OverlayManager(private val context: Context) {
    private val windowManager = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
    private var overlayView: LinearLayout? = null

    /**
     * @param reasonRes the STRING RESOURCE ID carried by
     *   [EnforcementResult.reasonRes]. Taking a resource id rather than a
     *   ready-made String is the whole point: it makes it structurally
     *   impossible for a caller to pass an English literal into the one
     *   screen the child actually sees.
     */
    fun show(reasonRes: Int, onGoHome: () -> Unit) {
        if (overlayView != null) return // already showing — don't stack duplicate overlays

        val layout = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(Color.parseColor("#0F1E1B")) // guardian-950, matching the Dashboard's palette
            setPadding(48, 48, 48, 48)
            // Arabic is the first language: mirror the whole overlay from
            // the resolved locale rather than assuming LTR. Without this a
            // window added straight to WindowManager (i.e. outside any
            // Activity) can keep the default LTR direction.
            layoutDirection = View.LAYOUT_DIRECTION_LOCALE
            textDirection = View.TEXT_DIRECTION_LOCALE
        }

        // Warm, non-punitive heading. CONTEXT §3 principle 7 forbids
        // "blocked"/"forbidden"/"you exceeded" — the child is being invited
        // to pause, not told off.
        val headingView = TextView(context).apply {
            text = context.getString(R.string.overlay_break_heading)
            setTextColor(Color.WHITE)
            textSize = 26f
            gravity = Gravity.CENTER
        }
        layout.addView(headingView)

        // The reason is itself a complete coaching sentence, e.g.
        // «وقت الشاشة انتهى الآن. خذ استراحة صغيرة وارجع لهدفك.»
        val messageView = TextView(context).apply {
            text = context.getString(reasonRes)
            setTextColor(Color.WHITE)
            textSize = 20f
            gravity = Gravity.CENTER
        }
        layout.addView(messageView, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT,
            LinearLayout.LayoutParams.WRAP_CONTENT,
        ).apply { topMargin = 24 })

        val homeButton = Button(context).apply {
            text = context.getString(R.string.overlay_action_go_home)
            setOnClickListener {
                hide()
                onGoHome()
            }
        }
        layout.addView(homeButton, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT,
            LinearLayout.LayoutParams.WRAP_CONTENT,
        ).apply { topMargin = 32 })

        val overlayType = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        } else {
            @Suppress("DEPRECATION")
            WindowManager.LayoutParams.TYPE_PHONE
        }

        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.MATCH_PARENT,
            overlayType,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT,
        )

        windowManager.addView(layout, params)
        overlayView = layout
    }

    fun hide() {
        val view = overlayView ?: return
        try {
            windowManager.removeView(view)
        } catch (e: IllegalArgumentException) {
            // View already detached — safe to ignore, matches the same
            // defensive style as RegistrationTokenGuard's error handling
            // on the backend (don't let a redundant cleanup call crash anything).
        }
        overlayView = null
    }

    val isShowing: Boolean get() = overlayView != null
}
