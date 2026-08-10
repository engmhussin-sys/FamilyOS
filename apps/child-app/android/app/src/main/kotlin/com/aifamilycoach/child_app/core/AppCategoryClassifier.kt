package com.aifamilycoach.child_app.core

/**
 * Sprint 14 (Behavioral Intelligence Engine) — CLOSES A REAL GAP: no
 * app category taxonomy existed anywhere before this. Classifies a
 * package name into a broad category ENTIRELY ON-DEVICE — the raw
 * package name itself never needs to leave the device for
 * categorization purposes (the category is what gets summed into
 * cloud-side analytics; the per-package minutes upload is unchanged,
 * still used for the Parent App's own detailed per-app view).
 *
 * Deliberately a static map, not a network lookup or ML classifier —
 * matches this module's own "statistical/rule-based, explainable"
 * discipline. A package not in the map falls back to OTHER — never
 * silently miscategorized as something specific it might not be.
 *
 * HONEST LIMITATION: this map covers common, well-known package
 * names as of this Sprint. It will not correctly classify every app
 * that exists — a real, ongoing maintenance need, not a one-time
 * completed task.
 */
object AppCategoryClassifier {

    private val EDUCATION = setOf(
        "com.duolingo", "com.khanacademy.android", "com.google.android.apps.classroom",
        "com.microsoft.teams", "us.zoom.videomeetings", "com.quizlet.quizletandroid",
        "com.coursera.android", "org.edx.mobile",
    )

    private val COMMUNICATION = setOf(
        "com.whatsapp", "com.google.android.gm", "com.google.android.apps.messaging",
        "com.microsoft.office.outlook", "com.skype.raider", "com.discord",
    )

    private val SOCIAL = setOf(
        "com.instagram.android", "com.facebook.katana", "com.snapchat.android",
        "com.twitter.android", "com.zhiliaoapp.musically",
        "com.linkedin.android", "com.reddit.frontpage",
    )

    private val GAMING = setOf(
        "com.roblox.client", "com.mojang.minecraftpe", "com.king.candycrushsaga",
        "com.supercell.clashofclans", "com.supercell.clashroyale", "com.epicgames.fortnite",
        "com.miHoYo.GenshinImpact", "com.innersloth.spacemafia",
        "com.dts.freefireth", "com.tencent.ig",
    )

    private val VIDEO = setOf(
        "com.google.android.youtube", "com.netflix.mediaclient", "com.disney.disneyplus",
        "com.amazon.avod.thirdpartyclient", "tv.twitch.android.app",
    )

    private val ENTERTAINMENT = setOf(
        "com.spotify.music", "com.google.android.apps.youtube.music", "com.apple.android.music",
    )

    private val PRODUCTIVITY = setOf(
        "com.google.android.apps.docs", "com.microsoft.office.word", "com.microsoft.office.excel",
        "com.google.android.calendar", "com.todoist", "com.evernote",
    )

    private val BROWSER = setOf(
        "com.android.chrome", "org.mozilla.firefox", "com.microsoft.emmx", "com.opera.browser",
    )

    private val UTILITIES = setOf(
        "com.android.settings", "com.google.android.apps.maps", "com.android.calculator2",
        "com.google.android.calculator",
    )

    /** Categorizes a single package name. Never throws — every input,
     * including an empty string or an unrecognized package, returns
     * a valid category (OTHER as the honest fallback). */
    fun classify(packageName: String): String = when (packageName) {
        in EDUCATION -> "EDUCATION"
        in COMMUNICATION -> "COMMUNICATION"
        in SOCIAL -> "SOCIAL"
        in GAMING -> "GAMING"
        in VIDEO -> "VIDEO"
        in ENTERTAINMENT -> "ENTERTAINMENT"
        in PRODUCTIVITY -> "PRODUCTIVITY"
        in BROWSER -> "BROWSER"
        in UTILITIES -> "UTILITIES"
        else -> "OTHER"
    }
}
