package com.aifamilycoach.child_app

import android.os.Build
import com.aifamilycoach.child_app.core.AgentChannel
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

/**
 * Step 1 (Core Architecture) scope only. This class intentionally does
 * NOT contain any AccessibilityService, UsageStatsManager, or
 * DevicePolicyManager code yet — those arrive in Steps 4–9 per the ADR
 * build order (child-agent-android-enforcement.md), each as its own
 * reviewed change. Calling any not-yet-built capability from Dart
 * reaches the `else -> result.notImplemented()` branch below, which the
 * Dart side (agent_channel_impl.dart) surfaces as a typed
 * AgentCapabilityNotImplementedException — never a silent fake success.
 */
class MainActivity : FlutterActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)

        MethodChannel(
            flutterEngine.dartExecutor.binaryMessenger,
            AgentChannel.CHANNEL_NAME,
        ).setMethodCallHandler { call, result ->
            when (call.method) {
                AgentChannel.METHOD_GET_NATIVE_APP_VERSION -> {
                    result.success(packageManager.getPackageInfo(packageName, 0).versionName)
                }

                AgentChannel.METHOD_GET_ANDROID_SDK_INT -> {
                    result.success(Build.VERSION.SDK_INT)
                }

                else -> result.notImplemented()
            }
        }
    }
}
