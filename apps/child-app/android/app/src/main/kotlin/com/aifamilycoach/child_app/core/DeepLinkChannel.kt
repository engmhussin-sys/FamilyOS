package com.aifamilycoach.child_app.core

/**
 * The MethodChannel name and method identifiers shared between
 * `MainActivity.kt` and `lib/core/routing/deep_link_channel.dart`.
 *
 * A SECOND CHANNEL, DELIBERATELY, RATHER THAN TWO MORE METHODS ON
 * [AgentChannel]. That channel is the enforcement agent's: permissions,
 * capability reports, policy sync, usage stats — a request/response surface the
 * Dart side reaches through `AgentPlatformChannel`. A deep link is the opposite
 * shape (native pushes, Dart listens) and belongs to routing, not to the agent.
 * Keeping them apart also keeps this app's channel identical in name and
 * methods to the parent app's, which is what lets one checker assert both.
 *
 * THERE IS DELIBERATELY NO SCHEME CONSTANT HERE — see the parent app's copy of
 * this file. The scheme lives in the backend registry (authoritative) and in
 * the manifest's `<data>` element (which is what routes the intent here at
 * all); a third spelling in Kotlin could only drift from those two.
 */
object DeepLinkChannel {
    const val CHANNEL_NAME = "com.aifamilycoach.child_app/deep_link"

    /** Dart -> native, once, at startup. Answers the cold-start URI or null. */
    const val METHOD_CONSUME_INITIAL_LINK = "consumeInitialLink"

    /** Native -> Dart, for every link that arrives while the app is alive. */
    const val METHOD_ON_DEEP_LINK = "onDeepLink"
}
