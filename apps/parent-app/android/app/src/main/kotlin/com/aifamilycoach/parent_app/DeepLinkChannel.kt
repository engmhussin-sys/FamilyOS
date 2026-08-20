package com.aifamilycoach.parent_app

/**
 * The MethodChannel name and method identifiers shared between
 * `MainActivity.kt` and `lib/core/routing/deep_link_channel.dart`.
 *
 * Named constants on both sides rather than inline literals, for the same
 * reason the child app's `AgentChannel` does it: there is no compile-time link
 * across the language boundary, so a typo is a silent runtime failure that only
 * appears on a real device — here, as a deep link that arrives at the process
 * and is never delivered to Dart.
 *
 * THERE IS DELIBERATELY NO SCHEME CONSTANT HERE. The scheme is declared in
 * exactly two places — the backend registry (`DEEP_LINK_SCHEME` in
 * `notification-destination.ts`, authoritative) and the `<data>` element of
 * AndroidManifest.xml (which is what makes the OS route the intent here at
 * all). This class does not add a third: `MainActivity` forwards the whole URI
 * of any VIEW intent it is given and lets Dart's `parseDeepLink` — the one
 * parser, already total — decide what it means. A scheme string in Kotlin could
 * only ever drift from the two that matter.
 */
object DeepLinkChannel {
    const val CHANNEL_NAME = "com.aifamilycoach.parent_app/deep_link"

    /** Dart -> native, once, at startup. Answers the cold-start URI or null. */
    const val METHOD_CONSUME_INITIAL_LINK = "consumeInitialLink"

    /** Native -> Dart, for every link that arrives while the app is alive. */
    const val METHOD_ON_DEEP_LINK = "onDeepLink"
}
