package com.aifamilycoach.parent_app

import android.content.Intent
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

/**
 * THE COLD-START HALF OF `abny://`, AND NOTHING ELSE.
 *
 * The recovery note this replaces (Sprint 17.3: "no native platform-channel
 * integration … a plain FlutterActivity is the correct, honest scaffold") was
 * accurate when it was written and its principle is kept: the only thing added
 * here is the DELIVERY of an intent the platform already hands this Activity
 * and that Dart previously never saw. No capability is invented.
 *
 * WHAT WAS BROKEN. AndroidManifest.xml now declares `<data android:scheme="abny">`,
 * so the OS resolves an external `abny://…` link to this app. Without the code
 * below that resolution merely LAUNCHES the app and the link is dropped on the
 * floor — `Intent.getData()` read by nobody, the app opening on its normal
 * landing screen as if the icon had been tapped. A declaration with no reader is
 * the same dead tap, one layer down.
 *
 * WHY NO PUB PACKAGE. `app_links` / `uni_links` would do this, but this
 * repository has no `pubspec.lock` and cannot resolve a new dependency here
 * (pub.dev answers 403), so adding one would be a build risk taken for
 * something a `MethodChannel` expresses in thirty lines with no new dependency
 * graph at all.
 *
 * TWO ARRIVAL PATHS, ONE HANDLER:
 *   * COLD START — the process is created for the intent. [configureFlutterEngine]
 *     captures `getIntent()` and Dart PULLS it once via
 *     [DeepLinkChannel.METHOD_CONSUME_INITIAL_LINK]. Pulled rather than pushed
 *     because at that moment the Dart side may not have registered a handler
 *     yet, and a pushed message would be delivered to nobody.
 *   * WARM START — the app is already running and `launchMode="singleTop"`
 *     (AndroidManifest.xml) delivers the new intent to THIS instance instead of
 *     creating a second one. That is [onNewIntent], which pushes
 *     [DeepLinkChannel.METHOD_ON_DEEP_LINK].
 *
 * THE URI IS FORWARDED VERBATIM AND JUDGED NOWHERE HERE. `parseDeepLink` in
 * `lib/core/routing/deep_link.dart` is the one parser, it is total, and every
 * rejection it has is a value (the inbox). A second opinion in Kotlin — a
 * scheme check, a surface list — could only drift from it.
 */
class MainActivity : FlutterActivity() {

    /** Non-null between [configureFlutterEngine] and [cleanUpFlutterEngine]. */
    private var deepLinkChannel: MethodChannel? = null

    /**
     * The cold-start URI, held until Dart asks for it exactly once.
     *
     * Also the parking space for a warm-start link that arrives before the
     * channel exists, so such a link is delayed rather than lost.
     */
    private var pendingLink: String? = null

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)

        // The intent that STARTED this Activity. Read here rather than in
        // onCreate because this is the first point at which there is a Dart
        // side to deliver it to.
        if (pendingLink == null) {
            pendingLink = linkFrom(intent)
        }

        val channel = MethodChannel(
            flutterEngine.dartExecutor.binaryMessenger,
            DeepLinkChannel.CHANNEL_NAME,
        )
        channel.setMethodCallHandler { call, result ->
            when (call.method) {
                DeepLinkChannel.METHOD_CONSUME_INITIAL_LINK -> {
                    // CONSUMED, not merely read: a hot restart or a second
                    // caller must not re-navigate to a link the user already
                    // followed minutes ago.
                    val link = pendingLink
                    pendingLink = null
                    result.success(link)
                }

                else -> result.notImplemented()
            }
        }
        deepLinkChannel = channel
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        // Keeps getIntent() honest for anything that reads it later, including
        // a consumeInitialLink that follows a configuration change.
        setIntent(intent)

        val link = linkFrom(intent) ?: return
        val channel = deepLinkChannel
        if (channel == null) {
            pendingLink = link
            return
        }
        channel.invokeMethod(DeepLinkChannel.METHOD_ON_DEEP_LINK, link)
    }

    /**
     * A reply into a dead engine is a crash, and a retained handler leaks this
     * Activity across a configuration change.
     */
    override fun cleanUpFlutterEngine(flutterEngine: FlutterEngine) {
        deepLinkChannel?.setMethodCallHandler(null)
        deepLinkChannel = null
        super.cleanUpFlutterEngine(flutterEngine)
    }

    /**
     * The URI of a VIEW intent, or null for every other way this Activity is
     * started — the launcher icon above all, which carries ACTION_MAIN and no
     * data and must never be mistaken for a deep link.
     */
    private fun linkFrom(intent: Intent?): String? {
        if (intent == null || intent.action != Intent.ACTION_VIEW) return null
        return intent.data?.toString()
    }
}
