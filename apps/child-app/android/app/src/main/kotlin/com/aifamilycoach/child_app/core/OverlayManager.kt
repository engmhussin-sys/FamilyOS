package com.aifamilycoach.child_app.core

import android.content.Context
import android.graphics.Color
import android.graphics.PixelFormat
import android.os.Build
import android.view.Gravity
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

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

    fun show(reason: String, onGoHome: () -> Unit) {
        if (overlayView != null) return // already showing — don't stack duplicate overlays

        val layout = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(Color.parseColor("#0F1E1B")) // guardian-950, matching the Dashboard's palette
            setPadding(48, 48, 48, 48)
        }

        val messageView = TextView(context).apply {
            text = "This app is blocked right now.\n$reason"
            setTextColor(Color.WHITE)
            textSize = 20f
            gravity = Gravity.CENTER
        }
        layout.addView(messageView)

        val homeButton = Button(context).apply {
            text = "Go to Home Screen"
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
