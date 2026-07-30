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
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)

        val permissionManager = PermissionManager(applicationContext)
        val capabilityEngine = DeviceCapabilityEngine(applicationContext)
        val antiTamperDetector = AntiTamperDetector(applicationContext)
        val nativePolicyStore = NativePolicyStore(applicationContext)

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
                    result.success(
                        permissionManager.isAccessibilityServiceEnabled(
                            AgentChannel.ACCESSIBILITY_SERVICE_COMPONENT_NAME_PLACEHOLDER,
                        ),
                    )
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

                // --- Sprint 4: Device Capability Engine ---
                AgentChannel.METHOD_GET_CAPABILITY_REPORT -> {
                    val report = capabilityEngine.collect(
                        AgentChannel.ACCESSIBILITY_SERVICE_COMPONENT_NAME_PLACEHOLDER,
                    )
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
                    result.success(
                        antiTamperDetector.checkAll(
                            AgentChannel.ACCESSIBILITY_SERVICE_COMPONENT_NAME_PLACEHOLDER,
                        ),
                    )
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
                        result.success(null)
                    }
                }

                AgentChannel.METHOD_GET_ENFORCEMENT_STATUS -> {
                    val accessibilityEnabled = permissionManager.isAccessibilityServiceEnabled(
                        AgentChannel.ACCESSIBILITY_SERVICE_COMPONENT_NAME_PLACEHOLDER,
                    )
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
                    result.success(null)
                }

                else -> result.notImplemented()
            }
        }
    }
}
