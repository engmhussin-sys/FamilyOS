package com.aifamilycoach.child_app.core

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * Independent of flutter_secure_storage on purpose — this must be
 * readable by AccessibilityService/ForegroundService even if the
 * Flutter engine isn't running (app killed, device just booted before
 * Flutter ever attaches). Not encrypted (SharedPreferences, not
 * EncryptedSharedPreferences) — the data here (daily limit, bedtime,
 * blocked package names) is not the kind of secret that justifies the
 * complexity; the device's identity keypair (DeviceIdentityKeyManager)
 * and auth tokens (Flutter's SecureTokenStorage) remain the only things
 * actually protected at that level.
 */
class NativePolicyStore(context: Context) {
    private val prefs = context.getSharedPreferences("afdc_runtime_policy", Context.MODE_PRIVATE)

    fun save(policy: NativePolicy) {
        prefs.edit()
            .putInt("dailyLimitMinutes", policy.dailyLimitMinutes ?: -1)
            .putString("bedtimeStart", policy.bedtimeStart)
            .putString("bedtimeEnd", policy.bedtimeEnd)
            .putBoolean("focusModeEnabled", policy.focusModeEnabled)
            .putString("blockedPackages", JSONArray(policy.blockedPackages).toString())
            .putLong("syncedAtMillis", System.currentTimeMillis())
            .apply()
    }

    fun load(): NativePolicy {
        val dailyLimit = prefs.getInt("dailyLimitMinutes", -1)
        val blockedJson = prefs.getString("blockedPackages", "[]") ?: "[]"
        val blocked = mutableListOf<String>()
        val array = JSONArray(blockedJson)
        for (i in 0 until array.length()) blocked.add(array.getString(i))

        return NativePolicy(
            dailyLimitMinutes = if (dailyLimit >= 0) dailyLimit else null,
            bedtimeStart = prefs.getString("bedtimeStart", null),
            bedtimeEnd = prefs.getString("bedtimeEnd", null),
            focusModeEnabled = prefs.getBoolean("focusModeEnabled", false),
            blockedPackages = blocked,
        )
    }

    fun lastSyncedAtMillis(): Long = prefs.getLong("syncedAtMillis", 0L)

    /**
     * Sprint 5 — the Child Runtime Engine's own "must still remain
     * protected offline" fallback (child-runtime-engine.md §5's Dart
     * equivalent, `defaultOfflinePolicy`, mirrored here since this store
     * must work without Flutter). Conservative, not "no limits."
     */
    companion object {
        val DEFAULT_OFFLINE_POLICY = NativePolicy(
            dailyLimitMinutes = 120,
            bedtimeStart = "21:00",
            bedtimeEnd = "07:00",
            focusModeEnabled = false,
            blockedPackages = emptyList(),
        )
    }
}

data class NativePolicy(
    val dailyLimitMinutes: Int?,
    val bedtimeStart: String?,
    val bedtimeEnd: String?,
    val focusModeEnabled: Boolean,
    val blockedPackages: List<String>,
) {
    fun toJson(): String = JSONObject().apply {
        put("dailyLimitMinutes", dailyLimitMinutes ?: JSONObject.NULL)
        put("bedtimeStart", bedtimeStart ?: JSONObject.NULL)
        put("bedtimeEnd", bedtimeEnd ?: JSONObject.NULL)
        put("focusModeEnabled", focusModeEnabled)
        put("blockedPackages", JSONArray(blockedPackages))
    }.toString()
}
