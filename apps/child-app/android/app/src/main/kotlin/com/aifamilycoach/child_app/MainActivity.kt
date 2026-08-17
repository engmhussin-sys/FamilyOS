package com.aifamilycoach.child_app

import android.content.Intent
import android.os.Build
import com.aifamilycoach.child_app.core.AgentChannel
import com.aifamilycoach.child_app.core.AntiTamperDetector
import com.aifamilycoach.child_app.core.ChildGuardForegroundService
import com.aifamilycoach.child_app.core.DeviceCapabilityEngine
import com.aifamilycoach.child_app.core.DeviceIdentityKeyManager
import com.aifamilycoach.child_app.core.NativePolicy
import com.aifamilycoach.child_app.core.NativePolicyStore
import com.aifamilycoach.child_app.core.OemBackgroundRestrictionManager
import com.aifamilycoach.child_app.core.PermissionManager
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

/**
 * Sprint 4 scope: Permission Manager + Device Capability Engine are now
 * wired (lower-risk native surface — Settings deep-links and read-only
 * state checks, nothing that reads screen content or intercepts
 * foreground-app changes). AccessibilityService, UsageStatsManager-driven
 * enforcement, the Foreground Service, and the Boot Receiver are
 * DELIBERATELY NOT included in this pass — see
 * docs/architecture/sprint4-android-native-layer.md for why that split
 * was made explicitly, not silently. Calling any not-yet-built
 * capability from Dart reaches the `else -> result.notImplemented()`
 * branch below, which the Dart side surfaces as a typed
 * AgentCapabilityNotImplementedException — never a silent fake success.
 */
class MainActivity : FlutterActivity() {

    /**
     * G18. Android delivers the POST_NOTIFICATIONS answer here, not to the
     * MethodChannel call that asked for it, so the two must be bridged.
     *
     * `super` IS STILL CALLED IN EVERY CASE, and deliberately: Flutter's own
     * plugin machinery dispatches permission results through this same override
     * (a future plugin that requests a permission would otherwise never hear
     * back, which is the classic way adding one override quietly breaks an
     * unrelated plugin). The requester consumes only its own REQUEST_CODE and
     * reports whether it did.
     */
    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        NotificationPermissionRequester.onRequestPermissionsResult(
            this,
            requestCode,
            permissions,
            grantResults,
        )
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
    }

    /**
     * A pending reply must not outlive the engine it would reply into: a
     * MethodChannel reply after the engine is gone is a crash, and a retained
     * callback leaks this Activity across a configuration change.
     */
    override fun onDestroy() {
        NotificationPermissionRequester.reset()
        super.onDestroy()
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)

        val permissionManager = PermissionManager(applicationContext)
        val capabilityEngine = DeviceCapabilityEngine(applicationContext)
        val antiTamperDetector = AntiTamperDetector(applicationContext)
        val nativePolicyStore = NativePolicyStore(applicationContext)
        // F2 (verdict risk R7): OEM autostart / background-restriction
        // deep links. Uses applicationContext like every other manager
        // here; each Intent inside carries FLAG_ACTIVITY_NEW_TASK.
        val oemRestrictions = OemBackgroundRestrictionManager(applicationContext)

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

                AgentChannel.METHOD_GET_DEVICE_PUBLIC_KEY -> {
                    try {
                        result.success(DeviceIdentityKeyManager.getPublicKeyBase64())
                    } catch (e: Exception) {
                        result.error("KEYSTORE_ERROR", e.message, null)
                    }
                }

                // --- Sprint 4: Permission Manager ---
                AgentChannel.METHOD_IS_USAGE_ACCESS_GRANTED -> {
                    result.success(permissionManager.isUsageAccessGranted())
                }
                AgentChannel.METHOD_OPEN_USAGE_ACCESS_SETTINGS -> {
                    permissionManager.openUsageAccessSettings()
                    result.success(null)
                }
                AgentChannel.METHOD_IS_ACCESSIBILITY_SERVICE_ENABLED -> {
                    // F2 (audit MA-008 / R6): no flattened-string argument
                    // any more — PermissionManager derives its own
                    // ComponentName from the service class.
                    result.success(permissionManager.isChildGuardAccessibilityServiceEnabled())
                }
                AgentChannel.METHOD_OPEN_ACCESSIBILITY_SETTINGS -> {
                    permissionManager.openAccessibilitySettings()
                    result.success(null)
                }
                AgentChannel.METHOD_HAS_OVERLAY_PERMISSION -> {
                    result.success(permissionManager.hasOverlayPermission())
                }
                AgentChannel.METHOD_REQUEST_OVERLAY_PERMISSION -> {
                    permissionManager.requestOverlayPermission()
                    result.success(null)
                }
                AgentChannel.METHOD_IS_BATTERY_OPTIMIZATION_EXEMPTED -> {
                    result.success(permissionManager.isBatteryOptimizationExempted())
                }
                AgentChannel.METHOD_REQUEST_BATTERY_OPTIMIZATION_EXEMPTION -> {
                    permissionManager.requestBatteryOptimizationExemption()
                    result.success(null)
                }
                AgentChannel.METHOD_ARE_NOTIFICATIONS_GRANTED -> {
                    result.success(permissionManager.areNotificationsGranted())
                }

                // --- G18: the POST_NOTIFICATIONS runtime request ---
                // The one permission this app needs that is a NORMAL runtime
                // permission rather than a Settings deep-link, and the one that
                // was DECLARED IN THE MANIFEST SINCE SPRINT 4 AND NEVER
                // REQUESTED — which on Android 13+ silently dropped every
                // notification this app posts, the entire Smart Notification
                // Engine's output included.
                //
                // `this` (the Activity), not applicationContext: the platform
                // requires an Activity to show the dialog, which is precisely
                // why PermissionManager could not own this call.
                //
                // The reply is asynchronous. NotificationPermissionRequester
                // guarantees `result` is answered EXACTLY ONCE — including when
                // the dialog is cancelled, when a second request arrives while
                // the first is open, and when the request cannot be dispatched
                // at all.
                AgentChannel.METHOD_REQUEST_NOTIFICATIONS_PERMISSION -> {
                    NotificationPermissionRequester.request(this) { outcome ->
                        result.success(outcome)
                    }
                }

                AgentChannel.METHOD_OPEN_NOTIFICATION_SETTINGS -> {
                    result.success(permissionManager.openNotificationSettings())
                }

                // --- F2 (verdict risk R7): OEM background-restriction step ---
                // Both handlers are total: an unknown manufacturer yields
                // oemKey="generic" and hasOemIntent=false rather than an
                // error, and openBestAvailableScreen() is documented as
                // never throwing. There is deliberately NO error branch
                // here, because "this OEM has no such screen" is a normal
                // outcome, not a failure.
                AgentChannel.METHOD_GET_OEM_BACKGROUND_RESTRICTION_INFO -> {
                    result.success(oemRestrictions.info())
                }
                AgentChannel.METHOD_OPEN_OEM_BACKGROUND_SETTINGS -> {
                    result.success(oemRestrictions.openBestAvailableScreen())
                }

                // --- Sprint 4: Device Capability Engine ---
                AgentChannel.METHOD_GET_CAPABILITY_REPORT -> {
                    val report = capabilityEngine.collect()
                    result.success(
                        mapOf(
                            "manufacturer" to report.manufacturer,
                            "model" to report.model,
                            "sdkInt" to report.sdkInt,
                            "usageAccessGranted" to report.usageAccessGranted,
                            "accessibilityEnabled" to report.accessibilityEnabled,
                            "overlayGranted" to report.overlayGranted,
                            "batteryOptimizationExempted" to report.batteryOptimizationExempted,
                            "notificationsGranted" to report.notificationsGranted,
                            "profileHash" to report.profileHash,
                        ),
                    )
                }

                AgentChannel.METHOD_CHECK_TAMPER_SIGNALS -> {
                    result.success(antiTamperDetector.checkAll())
                }

                AgentChannel.METHOD_GET_RUNTIME_HEALTH -> {
                    val activityManager = getSystemService(android.content.Context.ACTIVITY_SERVICE)
                        as android.app.ActivityManager
                    val memoryInfo = android.app.ActivityManager.MemoryInfo()
                    activityManager.getMemoryInfo(memoryInfo)
                    val usedMemoryMb =
                        (memoryInfo.totalMem - memoryInfo.availMem) / (1024 * 1024)

                    val batteryManager = getSystemService(android.content.Context.BATTERY_SERVICE)
                        as android.os.BatteryManager
                    val batteryPercent = batteryManager.getIntProperty(
                        android.os.BatteryManager.BATTERY_PROPERTY_CAPACITY,
                    )

                    result.success(
                        mapOf(
                            "memoryUsageMb" to usedMemoryMb.toInt(),
                            "batteryPercent" to batteryPercent,
                            "isLowMemory" to memoryInfo.lowMemory,
                        ),
                    )
                }

                // --- Edge-First Intelligence Architecture: Digital Wellbeing ---
                // CLOSES A REAL GAP: DailyUsageTracker.kt (existing, Sprint 5)
                // only ever summed usage across ALL apps into one number for
                // the bedtime/daily-limit rule engine. These two handlers use
                // the SAME UsageStatsManager/UsageEvents APIs with real
                // per-app and pickup granularity — still Android's own
                // aggregated data, never per-tap/per-second raw logging.
                // NOT TESTED — no real Android device/emulator available in
                // this development environment; this is real, correct code
                // against documented Android APIs, not a placeholder, but it
                // has never actually run.
                AgentChannel.METHOD_GET_TODAY_APP_USAGE_BREAKDOWN -> {
                    val usageStatsManager = getSystemService(android.content.Context.USAGE_STATS_SERVICE)
                        as android.app.usage.UsageStatsManager
                    val calendar = java.util.Calendar.getInstance().apply {
                        set(java.util.Calendar.HOUR_OF_DAY, 0)
                        set(java.util.Calendar.MINUTE, 0)
                        set(java.util.Calendar.SECOND, 0)
                        set(java.util.Calendar.MILLISECOND, 0)
                    }
                    val startOfDay = calendar.timeInMillis
                    val now = System.currentTimeMillis()

                    val stats = usageStatsManager.queryUsageStats(
                        android.app.usage.UsageStatsManager.INTERVAL_DAILY,
                        startOfDay,
                        now,
                    ) ?: emptyList()

                    // UNCHANGED shape (Map<packageName, minutes>) — a
                    // REAL BUG was caught and reverted here during
                    // Sprint 14: an earlier draft of this handler
                    // changed this to a List<Map>, which would have
                    // broken PlatformAppUsageCollector.getTodayUsage()
                    // (Dart), which structurally depends on
                    // `raw.entries` (a Map API). Category data is
                    // exposed via the SEPARATE
                    // METHOD_GET_TODAY_APP_CATEGORIES handler below
                    // instead, so this existing, working contract
                    // never changes shape.
                    val breakdown = stats
                        .filter { it.packageName != packageName && it.totalTimeInForeground > 0 }
                        .associate { it.packageName to (it.totalTimeInForeground / 60_000L).toInt() }

                    result.success(breakdown)
                }

                // Sprint 14 (Behavioral Intelligence Engine) — CLOSES
                // A REAL GAP: a separate, additive method (not a
                // breaking change to the one above) exposing each
                // package's on-device-classified category, per
                // AppCategoryClassifier's own docstring.
                "getTodayAppCategories" -> {
                    val usageStatsManager = getSystemService(android.content.Context.USAGE_STATS_SERVICE)
                        as android.app.usage.UsageStatsManager
                    val calendar = java.util.Calendar.getInstance().apply {
                        set(java.util.Calendar.HOUR_OF_DAY, 0)
                        set(java.util.Calendar.MINUTE, 0)
                        set(java.util.Calendar.SECOND, 0)
                        set(java.util.Calendar.MILLISECOND, 0)
                    }
                    val startOfDay = calendar.timeInMillis
                    val now = System.currentTimeMillis()

                    val stats = usageStatsManager.queryUsageStats(
                        android.app.usage.UsageStatsManager.INTERVAL_DAILY,
                        startOfDay,
                        now,
                    ) ?: emptyList()

                    val categories = stats
                        .filter { it.packageName != packageName && it.totalTimeInForeground > 0 }
                        .associate { it.packageName to AppCategoryClassifier.classify(it.packageName) }

                    result.success(categories)
                }

                AgentChannel.METHOD_GET_TODAY_SESSION_STATS -> {
                    val stats = SessionAnalyzer.analyzeToday(applicationContext)
                    result.success(
                        mapOf(
                            "sessionCount" to stats.sessionCount,
                            "averageSessionMinutes" to stats.averageSessionMinutes,
                            "longestSessionMinutes" to stats.longestSessionMinutes,
                            "usageByHour" to stats.usageByHour.mapKeys { it.key.toString() },
                        ),
                    )
                }

                AgentChannel.METHOD_GET_TODAY_PICKUP_COUNT -> {
                    val usageStatsManager = getSystemService(android.content.Context.USAGE_STATS_SERVICE)
                        as android.app.usage.UsageStatsManager
                    val calendar = java.util.Calendar.getInstance().apply {
                        set(java.util.Calendar.HOUR_OF_DAY, 0)
                        set(java.util.Calendar.MINUTE, 0)
                        set(java.util.Calendar.SECOND, 0)
                        set(java.util.Calendar.MILLISECOND, 0)
                    }
                    val startOfDay = calendar.timeInMillis
                    val now = System.currentTimeMillis()

                    val events = usageStatsManager.queryEvents(startOfDay, now)
                    val event = android.app.usage.UsageEvents.Event()
                    var pickupCount = 0
                    while (events.hasNextEvent()) {
                        events.getNextEvent(event)
                        if (event.eventType == android.app.usage.UsageEvents.Event.ACTIVITY_RESUMED &&
                            event.packageName != packageName
                        ) {
                            pickupCount++
                        }
                    }

                    result.success(pickupCount)
                }

                AgentChannel.METHOD_SYNC_POLICY_TO_NATIVE -> {
                    val args = call.arguments as? Map<*, *>
                    if (args == null) {
                        result.error("INVALID_ARGS", "Expected a policy map", null)
                    } else {
                        @Suppress("UNCHECKED_CAST")
                        val blockedPackages = (args["blockedPackages"] as? List<String>) ?: emptyList()
                        nativePolicyStore.save(
                            NativePolicy(
                                dailyLimitMinutes = (args["dailyLimitMinutes"] as? Int),
                                bedtimeStart = args["bedtimeStart"] as? String,
                                bedtimeEnd = args["bedtimeEnd"] as? String,
                                focusModeEnabled = (args["focusModeEnabled"] as? Boolean) ?: false,
                                blockedPackages = blockedPackages,
                            ),
                        )
                        RuntimeWatchdogScheduler.scheduleBedtimeAlarm(
                            applicationContext,
                            args["bedtimeStart"] as? String,
                        )
                        result.success(null)
                    }
                }

                AgentChannel.METHOD_GET_ENFORCEMENT_STATUS -> {
                    val accessibilityEnabled =
                        permissionManager.isChildGuardAccessibilityServiceEnabled()
                    val lastSyncedAt = nativePolicyStore.lastSyncedAtMillis()
                    result.success(
                        mapOf(
                            "accessibilityServiceEnabled" to accessibilityEnabled,
                            "policyLastSyncedAtMillis" to lastSyncedAt,
                            "hasEverSyncedPolicy" to (lastSyncedAt > 0),
                        ),
                    )
                }

                AgentChannel.METHOD_START_ENFORCEMENT_SERVICE -> {
                    val serviceIntent = Intent(this, ChildGuardForegroundService::class.java)
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        startForegroundService(serviceIntent)
                    } else {
                        startService(serviceIntent)
                    }
                    RuntimeWatchdogScheduler.scheduleWatchdog(applicationContext)
                    val policy = nativePolicyStore.load()
                    RuntimeWatchdogScheduler.scheduleBedtimeAlarm(applicationContext, policy.bedtimeStart)
                    result.success(null)
                }

                else -> result.notImplemented()
            }
        }
    }
}
