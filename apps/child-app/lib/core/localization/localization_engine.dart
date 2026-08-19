/// CLOSES A REAL GAP found in a follow-up review: zero localization
/// system existed anywhere in this app — every screen a child
/// actually interacts with was English-only, despite the entire
/// documented target market (Gulf/Saudi) being Arabic-first. Mirrors
/// apps/parent-app/lib/core/localization/localization_engine.dart's
/// exact architecture for consistency across this project's own
/// multiple Flutter apps: same fallback strategy (requested locale ->
/// default locale -> the raw key itself), same `_one`/`_other`
/// pluralization, same `{{token}}` interpolation.
library;

enum AppLocale { en, ar }

const Map<AppLocale, Map<String, String>> _resources = {
  AppLocale.en: {
    'progress.badgeShared': 'Family',
    'progress.badgeUnnamed': 'A badge',
    'progress.badgesHint': 'Earned, not bought.',
    'progress.badgesNoneYet': 'No badges yet — finish a few goals and they\'ll show up here.',
    'session.questionNumber': 'Question {{number}}',
    'session.quizAnswered': '{{answered}} of {{total}}',
    'session.quizLoading': 'Getting your questions...',
    'session.quizUnavailableTitle': 'The quiz is not ready',
    'attemptStage.EXPIRED': 'Time passed',
    'attemptStage.IN_PROGRESS': 'Working on it',
    'attemptStage.PENDING_PARENT': 'With a grown-up',
    'attemptStage.REJECTED': 'Try it again',
    'attemptStage.REQUESTED': 'Just started',
    'attemptStage.SUBMITTED': 'Being checked',
    'attemptStage.VERIFIED': 'Done!',
    // The safety net for a status this app has never seen. `status` is an
    // open string on the backend, so an unmapped one would otherwise render
    // as the key — a backend status code in front of a child.
    'attemptStage.unknown': 'Your try',
    'attempts.earned': '{{count}} points',
    'attempts.emptyBody': 'Start a goal and you\'ll find it here.',
    'attempts.emptyTitle': 'You haven\'t tried one yet',
    'attempts.errorTitle': 'We couldn\'t get your attempts',
    'attempts.noDate': 'No date',
    'attempts.streakThen': '{{count}}-day streak',
    'attempts.title': 'My attempts',
    'category.ARABIC': 'Arabic',
    'category.CREATIVITY': 'Creativity',
    'category.ENGLISH': 'English',
    'category.FIQH': 'Fiqh',
    'category.HABITS': 'Habits',
    'category.HADITH': 'Hadith',
    'category.HEALTH': 'Health',
    'category.HOUSEWORK': 'Housework',
    'category.MANNERS': 'Manners',
    'category.MATH': 'Math',
    'category.PROGRAMMING': 'Programming',
    'category.QURAN': 'Quran',
    'category.READING': 'Reading',
    'category.SCIENCE': 'Science',
    'category.SKILLS': 'Skills',
    'category.SPORT': 'Sport',
    'category.STUDY': 'Study',
    'category.VOLUNTEERING': 'Volunteering',
    // Same safety net, for a category the server adds before this app knows
    // its name.
    'category.unknown': 'An activity',
    'celebrate.attemptsLeft': '{{count}} tries left',
    'celebrate.backToGoals': 'Back to my goals',
    'celebrate.notYetFallback': 'A little bit more. Give it another go!',
    'celebrate.notYetTitle': 'So close!',
    'celebrate.rewardInstant': 'The prize was counted right away.',
    'celebrate.rewardWaitsForParent': 'This prize needs a grown-up to hand it to you.',
    'celebrate.score': 'You got {{percent}}%',
    'celebrate.tryAgain': 'Try again',
    'celebrate.verifiedFallback': 'Nice! Your prize is counted.',
    'celebrate.verifiedTitle': 'Braaavo!',
    'celebrate.waitingFallback': 'We sent your attempt to a grown-up to look at.',
    'celebrate.waitingTitle': 'It reached a grown-up',
    // The coach tab. CHROME ONLY — every sentence the child reads about
    // themselves (today's message, the questions, the answers, the safety
    // card) is server-authored Arabic that has already passed the safety
    // engine at their own age band, and is rendered verbatim rather than
    // keyed. Nothing below is a substitute for any of it.
    'coach.checkinHint': 'Write how you are feeling today.',
    'coach.checkinPlaceholder': 'I feel...',
    'coach.checkinSend': 'Send',
    'coach.checkinTitle': 'How are you feeling today?',
    'coach.copyNumber': 'Copy the number',
    'coach.emptyBody': 'Come back a little later and there will be a new message.',
    'coach.emptyTitle': 'Nothing here just yet',
    'coach.errorTitle': 'We could not get today\'s message',
    'coach.loading': 'Getting today\'s message...',
    'coach.numberCopied': 'Number copied',
    'coach.questionsSubtitle': 'Tap a question to read the answer.',
    'coach.questionsTitle': 'Questions you might have',
    'coach.safetyDismiss': 'Okay, got it',
    'coach.title': 'My coach',
    'coach.todayTitle': 'Today\'s message',
    'common.loading': 'One sec...',
    'common.minutesValue': '{{count}} min',
    'goalDetail.bonusMinutes': 'extra minutes',
    'goalDetail.minutes': 'minutes',
    'goalDetail.points': 'points',
    'goalDetail.start': 'Let\'s start!',
    'goalDetail.title': 'The goal',
    'myRewards.bonusHint': 'These minutes run out on their own after a while.',
    'myRewards.bonusMinutes': 'active extra minutes',
    'myRewards.bonusSection': 'Extra time',
    'myRewards.emptyBody': 'Finish one goal and you\'ll find your first reward here.',
    'myRewards.emptyTitle': 'No rewards yet',
    'myRewards.errorTitle': 'We couldn\'t get your rewards',
    'myRewards.grantActive': 'Running',
    'myRewards.grantFinished': 'Finished',
    'myRewards.grantMinutes': '{{count}} minutes',
    'myRewards.loading': 'Getting your rewards...',
    'myRewards.noPrizes': 'No prizes waiting yet.',
    'myRewards.prizeDelivered': 'You got it',
    'myRewards.prizeWaiting': 'Waiting',
    'myRewards.prizesHint': 'These need a grown-up to hand them to you.',
    'myRewards.openStore': 'Open the store',
    'myRewards.prizesSection': 'My prizes',
    'myRewards.title': 'My rewards',
    'progress.badgesComingSoon': 'Badges are still on the way. Until they land, keep an eye on your streaks above.',
    'progress.badgesSection': 'Badges',
    'progress.emptyBody': 'Finish one goal and you\'ll find your points and streaks here.',
    'progress.emptyTitle': 'Still at the start',
    'progress.errorTitle': 'We couldn\'t get your progress',
    'progress.level': 'level',
    'progress.loading': 'Working out your progress...',
    'progress.openAttempts': 'See my attempts',
    'progress.points': 'points',
    'progress.pointsSection': 'My points',
    'progress.pointsUnavailable': 'Your points aren\'t showing right now.',
    'progress.streakDays': '{{count}} days',
    'progress.streaksHint': 'Every day you finish a goal, the streak grows.',
    'progress.streaksNoneYet': 'You haven\'t started a streak yet — today is a good day.',
    'progress.streaksSection': 'My streaks',
    'progress.streaksUnavailable': 'Your streaks aren\'t showing right now.',
    'progress.title': 'My progress',
    // THE WHOLE `RewardType` ENUM, and it was not whole before. The backend's
    // enum has nine values; this map had six of them plus `POINTS` (which the
    // F4 reward shape uses). `XP`, `COINS` and `BADGE` were missing, so a
    // fulfilment or a program reward of any of those three rendered the KEY —
    // «rewardType.BADGE» — to a child. See `tOrElse` at both call sites for the
    // tenth value the backend adds next.
    'rewardType.BADGE': 'A badge',
    'rewardType.COINS': 'Coins',
    'rewardType.CUSTOM_REWARD': 'Something you choose',
    'rewardType.DIGITAL_REWARD': 'A digital gift',
    'rewardType.PARENT_APPROVAL_REWARD': 'Parent approval',
    'rewardType.PHYSICAL_REWARD': 'A real gift',
    'rewardType.POINTS': 'Points',
    'rewardType.PRIVILEGE': 'A privilege',
    'rewardType.SCREEN_TIME': 'Extra screen time',
    'rewardType.XP': 'Experience points',
    'rewardType.unknown': 'A reward',
    'session.done': 'I\'m done!',
    'session.foregroundNote': 'The timer only counts while this app is open.',
    'session.notNowTitle': 'Not right now',
    'session.noteHint': 'A grown-up will read it.',
    'session.noteLabel': 'Want to say something? (optional)',
    'session.ofTarget': 'out of {{count}} minutes',
    'session.parentWillSee': 'A grown-up will look at it and decide.',
    'session.quizNotReady': 'The quiz isn\'t ready in this version yet. We\'ll send your attempt to a grown-up to look at.',
    'session.quizTitle': 'Short quiz',
    'session.selfConfirm': 'I finished the goal',
    'session.selfConfirmHint': 'Be honest — this one is between you and you.',
    'session.sendToParent': 'Send it to a grown-up',
    'session.serverWillCheck': 'We\'ll check first, then the prize comes.',
    'session.somethingHappenedTitle': 'Small hiccup',
    'session.targetReached': 'You finished the time!',
    'session.title': 'Working on it',
    // SPRINT F1 — `session.uploadNotReady` IS GONE, and its removal is what
    // this sprint is for. It said recording "isn't ready yet"; the recorder
    // and the pickers now exist and the route always did, so the sentence had
    // become false and the copy it justified pointed a child away from
    // something they can now actually do.
    //
    // EVERY KEY BELOW IS APP CHROME, WHICH IS WHY IT IS HERE AT ALL. These
    // refusals happen BEFORE any request is sent, so there is no server
    // sentence yet to render. From the moment the server does answer, its own
    // `messageAr` is shown verbatim through `KidErrorState` and nothing here
    // is consulted.
    //
    // NOT ONE OF THEM STATES AN OUTCOME. `stored` says the file arrived and
    // says nothing else — both methods that reach this route have
    // `canAutoApprove: false`, so a grown-up decides afterwards.
    'session.evidence.artifactHow': 'Take a picture of what you did, or pick one you already have.',
    'session.evidence.camera': 'Take a picture',
    'session.evidence.cancelRecording': 'Start over',
    'session.evidence.captureFailed': 'Your phone couldn\'t make the file this time. Have another go.',
    'session.evidence.document': 'Pick a file',
    'session.evidence.gallery': 'From my pictures',
    'session.evidence.micDenied': 'The microphone is off, so we can\'t record here. You can recite to a grown-up instead — they\'re the one who decides anyway.',
    'session.evidence.micWhy': 'We\'ll ask to use the microphone so we can record you reciting. Nothing is recorded until you press the button.',
    'session.evidence.none': 'Nothing sent yet.',
    'session.evidence.notAttachedYet': 'You can still send it — a grown-up will see there\'s no recording with it.',
    'session.evidence.recitationHow': 'Record yourself reciting. We send the recording, a grown-up listens, and they decide.',
    'session.evidence.record': 'Start recording',
    'session.evidence.recording': 'Recording... {{time}}',
    'session.evidence.replace': 'Send something else',
    'session.evidence.stop': 'I\'m finished reciting',
    'session.evidence.stored': 'Sent: {{name}}',
    'session.evidence.storedHint': 'A grown-up will look at it once you press the button below.',
    'session.evidence.tooLarge': 'That file is bigger than {{mb}} MB, so it won\'t go. Record a shorter bit, or send one picture.',
    'session.evidence.tooSmall': 'That file is nearly empty. Check the recording started, then try again.',
    'session.evidence.typeUnknown': 'We can\'t tell what kind of file that is. Try a recording or a picture.',
    'session.evidence.typeWrongArtifact': 'This one needs a picture or a file that shows your work, not a recording.',
    'session.evidence.typeWrongRecitation': 'This one needs a recording of you reciting, not a picture.',
    'session.evidence.uploadFailedTitle': 'It didn\'t go through',
    'session.evidence.uploading': 'Sending...',
    'session.uploadTitle': 'Recording or a picture',
    'shell.coach': 'Coach',
    'shell.deviceSettings': 'Device settings',
    'shell.myGrowth': 'My growth',
    'shell.progress': 'Progress',
    'shell.rewards': 'Rewards',
    'shell.today': 'Today',
    'streak.behaviour': 'Good behaviour',
    'streak.exercise': 'Exercise',
    'streak.learning': 'Learning',
    'streak.quran': 'Quran',
    'streak.reading': 'Reading',
    'today.allDoneForNow': 'You\'ve done what you can for now. Nice one!',
    'today.allDomains': 'Everything',
    'today.chooseDomain': 'What do you want to learn today?',
    'today.domainEmpty': 'No goal in this one yet — talk to your grown-up about it.',
    'today.emptyBody': 'Ask a grown-up to add one — then come back and start it.',
    'today.emptyTitle': 'No goals today',
    'today.errorTitle': 'We couldn\'t get your goals',
    'today.loading': 'Getting your goals...',
    'today.notNow': 'Not right now — see you later!',
    'today.pointsReward': '{{count}} points',
    'today.readyCount': 'You have {{count}} ready right now!',
    'today.readyNow': 'Ready now',
    'today.screenTimeReward': '{{count}} extra min',
    'today.title': 'Today\'s goals',
    'verifyForKid.ASSESSMENT_SCORE': 'We use your latest school score.',
    'verifyForKid.CODE_CHALLENGE': 'Your code has to pass the tests.',
    'verifyForKid.COMPLETION_ARTIFACT': 'Send something that shows you did it.',
    'verifyForKid.DURATION': 'We count the time you spend here.',
    'verifyForKid.DURATION_PLUS_QUIZ': 'Time here, plus a few questions.',
    'verifyForKid.PARENT_CONFIRMATION': 'A grown-up will look and decide.',
    'verifyForKid.QUIZ': 'A few quick questions at the end.',
    'verifyForKid.RECITATION_SUBMISSION': 'You recite, and a grown-up listens.',
    'verifyForKid.SELF_CHECK': 'You tell us when you finish.',
    // The fallback for a goal whose `verificationLevel` is missing or is a
    // method this app has not been taught. Says the true thing — someone
    // checks — without naming a mechanism it does not know.
    'verifyForKid.unknown': 'When you finish, this gets checked.',
    'common.error': 'Something went wrong.',
    'common.retry': 'Try Again',
    'common.done': 'Done!',
    'common.checking': 'Checking...',

    'pairing.title': "Let's get set up!",
    'pairing.instruction': 'Ask a grown-up for the code from their app, then type it in below.',
    'pairing.codeLabel': 'Pairing code',
    'pairing.codeHint': 'XXXX-XXXX',
    // TWO OUTCOMES, AND ONLY ONE OF THEM IS ABOUT THE CODE THE CHILD TYPED.
    //
    // `/pairing/accept` answers a wrong or expired code with a bare
    // UnauthorizedException, so B3's per-status fallback supplies «انتهت
    // جلستك. سجّل الدخول مرة أخرى للمتابعة.» — right for an expired session,
    // meaningless to a child on the first screen this app shows, who has no
    // session and has never logged in. There is no endpoint-written sentence
    // to carry through, so these two are the client's, and the server's own
    // text stays on `ApiFailure.diagnostic` where no widget reads it.
    //
    // Neither of them says "wrong", "failed", or blames the reader. The
    // second opens by saying the problem is not the child's, because a
    // first-run network error is the easiest moment in the whole product to
    // teach a seven-year-old that they broke something.
    'pairing.codeNotAccepted':
        "That code isn't working. Ask a grown-up to check it, or to make you a new one.",
    'pairing.cannotReach':
        "It's not you — we can't get through right now. Try again in a little bit.",
    'pairing.submit': "Let's Go!",

    'myGrowth.title': 'My Growth',
    'myGrowth.logWater': 'Log water',
    'myGrowth.habitDone': 'Awesome! "{{title}}" done!',
    'myGrowth.hydrationDone': 'Great job staying hydrated!',
    'myGrowth.faithDone': 'Well done! "{{title}}" complete!',
    'myGrowth.studyDone': 'Nice work studying today!',
    // THE BUTTON SAYS THE NUMBER IT SENDS. One tap logs a fixed 20 minutes of
    // movement — the same honest MVP shape as the study button and the 250 ml
    // water button — so the label names the amount instead of implying this
    // app measured anything.
    'myGrowth.logActivity': 'Log 20 min',
    'myGrowth.activityDone': 'Great moving today!',
    'myGrowth.smartTaskAccept': "I'll do it",
    'myGrowth.smartTaskDismiss': 'Not now',
    'myGrowth.healthTitle': 'My Health',
    'myGrowth.learningTitle': 'My Learning',
    'myGrowth.waterLabel': 'Water',
    'myGrowth.activityLabel': 'Activity',
    'myGrowth.achievedLabel': 'Done',
    'myGrowth.millilitresUnit': 'ml',
    'myGrowth.minutesUnit': 'min',
    'myGrowth.newLabel': 'New',
    'myGrowth.ringAllDone': 'You finished everything today!',
    'myGrowth.ringAllDoneLabel': 'All done',
    'myGrowth.ringGreeting': 'Hi {{name}}!',
    'myGrowth.ringGreetingAllDone': 'Amazing, {{name}}!',
    'myGrowth.ringKeepGoing': 'Let\'s finish today\'s list!',
    'myGrowth.ringNothingYet': 'Nothing to do yet today.',
    'myGrowth.xp': 'XP',
    'myGrowth.coins': 'Coins',
    'myGrowth.level': 'Level',
    'myGrowth.learningStreak': '{{count}}-day streak!',
    'myGrowth.learningNoStreak': 'Start your learning streak today',
    'myGrowth.sessionsCount': '{{count}} sessions (30d)',
    'myGrowth.studyNow': 'Study now',
    'myGrowth.loadError': "Oops! Something didn't load.",
    'myGrowth.tryAgainPrompt': "Let's try again!",
    'myGrowth.tryAgain': 'Try Again',
    'myGrowth.messages': 'Messages',
    'myGrowth.myHabits': 'My Habits',
    'myGrowth.faith': 'Faith',
    'myGrowth.noHabitsYet': 'No habits yet — ask a grown-up to add one!',
    'myGrowth.noPracticesYet': 'No practices yet — ask a grown-up to add one!',
    'myGrowth.noMessagesYet': 'No messages yet — this is where they land.',
    'myGrowth.done': 'Done!',

    'rewards.title': 'My Rewards',
    'rewards.storeTitle': 'Reward Store',
    'rewards.requested': 'Yay! "{{title}}" requested — ask a grown-up to approve it!',
    'rewards.coins': '{{count}} coins',
    'rewards.redeemFailed': "Couldn't request that right now — try again!",
    'rewards.noRewardsYet': 'No rewards yet — ask a grown-up to add some!',
    'rewards.loadError': "Oops! Something didn't load.",
    'rewards.tryAgain': 'Try Again',
    'rewards.coinsLabel': 'Coins',
    'rewards.getIt': 'Get it!',
    'rewards.askAnyway': "You're {{count}} coins short — ask anyway, a grown-up can help!",

    'deviceStatus.title': 'Device Status',
    'deviceStatus.pairedHeartbeat': '✅ Device paired. Heartbeat running.',
    'deviceStatus.myGrowth': 'My Growth',
    'deviceStatus.myRewards': 'My Rewards',
    'deviceStatus.runtimeStatus': 'Runtime Status',
    'deviceStatus.diagnostics': 'Diagnostics',
    'deviceStatus.permissions': 'Permissions',
    'deviceStatus.capabilities': 'Capabilities',
    'deviceStatus.syncCapabilities': 'Sync Capabilities Now',
    'deviceStatus.syncSuccess': 'Synced ✅',
    'deviceStatus.syncFailed': 'Sync failed — will retry on next heartbeat.',
    'deviceStatus.memoryUsage': 'Memory usage: {{mb}} MB',
    'deviceStatus.battery': 'Battery: {{percent}}%',
    'deviceStatus.batteryUnknown': 'unknown',
    'deviceStatus.healthNormal': 'Normal',
    'deviceStatus.healthAttention': 'Attention needed',
    'deviceStatus.healthLabel': 'Health: {{status}}',
    'deviceStatus.fix': 'Fix',
    'deviceStatus.protectionActive': 'Everything is set up',
    'deviceStatus.protectionNotActive': 'One step is still missing',
    'deviceStatus.accessibilityOff': 'One setting still needs a grown-up',
    'deviceStatus.noPolicySynced': 'We haven\'t synced with your family yet',
    'deviceStatus.enforcingPolicy': 'Working with your family plan',
    'deviceStatus.queuedUpdates': '{{count}} update(s) waiting to sync (offline)',

    // F2: child-facing permission names. "Accessibility Service" is a
    // platform term, not a name a child or a parent recognises.
    'permissions.usageAccess': 'App usage',
    'permissions.accessibilityService': 'Knowing which app is open',
    'permissions.overlay': 'Showing the break screen',
    'permissions.batteryOptimization': 'Staying on in the background',
    'permissions.notifications': 'Notifications',

    // ==================================================================
    // F2 — Prominent disclosure (Play policy, audit A3 §4/P2 + risk R5).
    // Shown ONCE, at first run, BEFORE pairing and before any sensitive
    // permission is requested. English is the fallback copy; Arabic below
    // is the real one for the first two markets.
    // Every field named here is a field the code actually sends. The list
    // is generated from digital_wellbeing_service.dart's daily-summary
    // payload, not from a marketing summary of it.
    // ==================================================================
    'disclosure.title': 'Before we start',
    'disclosure.intro':
        'ABNY helps you and your family agree on a healthy screen-time plan. So it can do that, this device sends a daily summary to your family account. Here is exactly what is in it.',
    'disclosure.dataHeading': 'What this device sends every day',
    'disclosure.dataUsageDate': 'The date of the summary.',
    'disclosure.dataTotalScreenMinutes': 'Total minutes of screen time.',
    'disclosure.dataAppBreakdown': 'Which apps were used and for how many minutes, plus each app category (learning, games, other).',
    'disclosure.dataPickupCount': 'How many times the phone was picked up.',
    'disclosure.dataNightUsageMinutes': 'Minutes used at night (10pm-6am).',
    'disclosure.dataBlockedAttemptCount': 'How many times an app outside the plan was opened.',
    'disclosure.dataSessionCount': 'How many usage sessions there were.',
    'disclosure.dataAverageSessionMinutes': 'The average length of a session.',
    'disclosure.dataLongestSessionMinutes': 'The length of the longest session.',
    'disclosure.notCollectedHeading': 'What is never collected',
    'disclosure.notCollectedContent': 'Nothing shown on the screen: no messages, no photos, no passwords, no what-you-type.',
    'disclosure.notCollectedAudio': 'No microphone, no camera, no call or message content.',
    'disclosure.notCollectedLocation': 'No location.',
    'disclosure.whoSees': 'Only the parent who set up this family account can see this. It is not sold and it is not shared for advertising.',
    'disclosure.control': 'A parent can ask to see, export or delete all of it at any time.',
    'disclosure.privacyPolicy': 'Read the full privacy policy',
    'disclosure.accept': 'I understand — continue',
    'disclosure.decline': 'Not now',
    'disclosure.declined': 'No problem. Nothing has been sent. You can come back whenever you are ready.',
    'disclosure.declinedAction': 'Read again',

    // ------------------------------------------------------------------
    // F2 — Accessibility pre-permission priming (Play policy P1/P2).
    // Shown BEFORE the system Accessibility screen, every time we send the
    // user there. Honest, specific, and not scary.
    // ------------------------------------------------------------------
    'priming.title': 'One more step to make the plan work',
    'priming.what': 'Android needs your permission before ABNY can tell which app is open right now.',
    'priming.reads': 'What it reads: the name of the app currently in the foreground. That is all.',
    'priming.doesNotRead': 'What it does not read: anything shown on the screen — no messages, no passwords, no what-you-type. The service is set up so it technically cannot.',
    'priming.why': 'Without it, the daily plan and quiet hours cannot start at the right moment.',
    'priming.stepsHeading': 'On the next screen',
    'priming.step1': 'Find "ABNY screen-time plan" in the list.',
    'priming.step2': 'Turn it on and confirm.',
    'priming.step3': 'Come back here — the status turns green on its own.',
    'priming.reversible': 'You can turn it off again from the same screen whenever you want.',
    'priming.open': 'Open settings',
    'priming.later': 'Later',

    // ------------------------------------------------------------------
    // G18 — POST_NOTIFICATIONS pre-permission priming.
    //
    // Shown IMMEDIATELY BEFORE the Android 13+ system notification dialog,
    // and never on cold start. Android shows that dialog at most twice in
    // an app's entire lifetime, so spending one of those on a child who has
    // no idea what is being asked wastes a chance that does not come back.
    //
    // The copy names what the CHILD gets (their own reward news, a warning
    // before quiet hours) rather than what the app wants, and promises
    // nothing the app does not do: no marketing, no telling-off, and
    // declining is presented as genuinely fine — CONTEXT §3.7,
    // non-punitive.
    // ------------------------------------------------------------------
    'notifPriming.title': 'Can ABNY send you little messages?',
    'notifPriming.what':
        'ABNY would like to send short messages to this phone — never more than a line or two.',
    'notifPriming.example1': 'When you have earned a new reward.',
    'notifPriming.example2':
        'A heads-up before quiet hours begin, so nothing stops suddenly in the middle of a game.',
    'notifPriming.example3': 'A "well done" when you finish something you planned.',
    'notifPriming.why':
        'Without this permission Android hides all of them, and you would only find out by opening the app yourself.',
    'notifPriming.noSpam':
        'No adverts, and never a message that tells you off. You can switch them off again whenever you like.',
    'notifPriming.allow': 'Yes, send them',
    'notifPriming.later': 'Not now',
    'notifPriming.granted': 'Done — ABNY can send you messages now.',
    'notifPriming.denied':
        'No problem. Everything else still works — you just will not get messages. You can turn them on any time from this screen.',
    'notifPriming.permanentlyDenied':
        'Android will not ask again, so messages have to be switched on from the phone settings.',
    'notifPriming.openSettings': 'Open settings',

    // ------------------------------------------------------------------
    // F2 — OEM autostart / battery step (audit verdict risk R7).
    // ------------------------------------------------------------------
    'oem.title': 'Keep the plan running',
    'oem.intro': 'Some phones close background apps to save battery. When that happens, the plan on this phone quietly stops working. One setting prevents it.',
    'oem.reassure': 'This does not use extra battery — it only stops the phone from switching ABNY off by itself.',
    'oem.stepsHeading': 'On the next screen',
    'oem.step.xiaomi': 'Open Autostart, find ABNY, and turn it on. Then, under Battery saver, choose "No restrictions".',
    'oem.step.oppo': 'Turn on "Allow auto-startup" for ABNY, then set its background power usage to "Allow".',
    'oem.step.vivo': 'Turn on "Auto-start" for ABNY, and add it to the high background power consumption allow-list.',
    'oem.step.huawei': 'Open App launch, switch ABNY to Manage manually, and turn on all three switches.',
    'oem.step.samsung': 'Find ABNY in the battery list and turn off "Put app to sleep" / remove it from Sleeping apps.',
    'oem.step.transsion': 'Open Auto-start management in PhoneMaster and allow ABNY to start automatically.',
    'oem.step.generic': 'Find ABNY in the list and allow it to keep running in the background.',
    'oem.open': 'Open the settings screen',
    'oem.done': 'Done',
    'oem.skip': 'Skip for now',
    'oem.openedOemAutostart': 'That is the right screen — find ABNY in the list.',
    'oem.openedBatteryOptimization': 'This phone has no autostart list, so we opened the battery screen instead. Set ABNY to unrestricted.',
    'oem.openedAppDetails': 'We opened this app\'s settings page. Look for Battery, then allow background activity.',
    'oem.openedNone': 'This phone did not let us open that screen. You can find it in Settings > Battery.',
    'oem.deviceLabel': 'Your phone: {{manufacturer}}',
  },
  AppLocale.ar: {
    'progress.badgeShared': 'للعيلة',
    'progress.badgeUnnamed': 'شارة',
    'progress.badgesHint': 'اتكسبت، ما اتشتراتش.',
    'progress.badgesNoneYet': 'لسه مفيش شارات — خلّص كام هدف وهتلاقيهم هنا.',
    'session.questionNumber': 'سؤال {{number}}',
    'session.quizAnswered': '{{answered}} من {{total}}',
    'session.quizLoading': 'بنجيب أسئلتك…',
    'session.quizUnavailableTitle': 'الاختبار مش جاهز',
    'attemptStage.EXPIRED': 'الوقت عدّى',
    'attemptStage.IN_PROGRESS': 'شغّال عليه',
    'attemptStage.PENDING_PARENT': 'عند ولي أمرك',
    'attemptStage.REJECTED': 'جرّبه تاني',
    'attemptStage.REQUESTED': 'لسه بادي',
    'attemptStage.SUBMITTED': 'بنتأكد منه',
    'attemptStage.VERIFIED': 'خلصت!',
    'attemptStage.unknown': 'محاولتك',
    'attempts.earned': '{{count}} نقطة',
    'attempts.emptyBody': 'أول ما تبدأ هدف، هتلاقيه هنا.',
    'attempts.emptyTitle': 'لسه مجربتش',
    'attempts.errorTitle': 'مقدرناش نجيب محاولاتك',
    'attempts.noDate': 'من غير تاريخ',
    'attempts.streakThen': 'تتابع {{count}} يوم',
    'attempts.title': 'محاولاتي',
    'category.ARABIC': 'عربي',
    'category.CREATIVITY': 'إبداع',
    'category.ENGLISH': 'إنجليزي',
    'category.FIQH': 'فقه',
    'category.HABITS': 'عادات',
    'category.HADITH': 'حديث',
    'category.HEALTH': 'صحة',
    'category.HOUSEWORK': 'أعمال منزلية',
    'category.MANNERS': 'أدب وسلوك',
    'category.MATH': 'رياضيات',
    'category.PROGRAMMING': 'برمجة',
    'category.QURAN': 'قرآن',
    'category.READING': 'قراءة',
    'category.SCIENCE': 'علوم',
    'category.SKILLS': 'مهارات',
    'category.SPORT': 'رياضة',
    'category.STUDY': 'دراسة',
    'category.VOLUNTEERING': 'تطوع',
    'category.unknown': 'نشاط',
    'celebrate.attemptsLeft': 'فاضل لك {{count}} محاولة',
    'celebrate.backToGoals': 'رجوع لأهدافي',
    'celebrate.notYetFallback': 'فاضل شوية صغيرين. جرّب تاني!',
    'celebrate.notYetTitle': 'قربت أوي!',
    'celebrate.rewardInstant': 'الجايزة اتحسبت على طول.',
    'celebrate.rewardWaitsForParent': 'الجايزة دي محتاجة حد كبير يسلّمهالك.',
    'celebrate.score': 'نتيجتك {{percent}}%',
    'celebrate.tryAgain': 'جرّب تاني',
    'celebrate.verifiedFallback': 'تمام! جايزتك اتحسبت.',
    'celebrate.verifiedTitle': 'برااافو!',
    'celebrate.waitingFallback': 'بعتنا محاولتك لحد كبير يشوفها.',
    'celebrate.waitingTitle': 'وصلت لحد كبير',
    // The coach tab, Arabic chrome. Same rule as the `en` block: the
    // sentences the child reads about themselves are server-authored and
    // rendered verbatim; only these labels are keyed.
    //
    // `coach.checkinHint` PROMISES NOTHING, DELIBERATELY. It does not say
    // "nobody will read this" — a check-in that trips the distress
    // classifier does alert a parent (generically, quoting nothing). Nor
    // does it say "we will tell your parent", because a disclosed detector
    // is a detector a child in trouble stops writing to. Whether, and how,
    // to disclose that escalation to the child is a PRODUCT DECISION that
    // has not been taken; until it is, this line states only what the child
    // is being asked to do.
    'coach.checkinHint': 'اكتب اللي حاسس بيه النهاردة.',
    'coach.checkinPlaceholder': 'أنا حاسس إني…',
    'coach.checkinSend': 'ابعت',
    'coach.checkinTitle': 'إنت حاسس بإيه النهاردة؟',
    'coach.copyNumber': 'انسخ الرقم',
    'coach.emptyBody': 'ارجع بعد شوية وهتلاقي رسالة جديدة.',
    'coach.emptyTitle': 'مفيش حاجة هنا لسه',
    'coach.errorTitle': 'مقدرناش نجيب رسالة النهاردة',
    'coach.loading': 'بنجهّز رسالة النهاردة…',
    'coach.numberCopied': 'الرقم اتنسخ',
    'coach.questionsSubtitle': 'اضغط على السؤال وهتلاقي الإجابة.',
    'coach.questionsTitle': 'أسئلة ممكن تكون في بالك',
    'coach.safetyDismiss': 'تمام، فهمت',
    'coach.title': 'مدرّبي',
    'coach.todayTitle': 'رسالة النهاردة',
    'common.loading': 'ثانية واحدة…',
    'common.minutesValue': '{{count}} دقيقة',
    'goalDetail.bonusMinutes': 'دقيقة زيادة',
    'goalDetail.minutes': 'دقيقة',
    'goalDetail.points': 'نقطة',
    'goalDetail.start': 'يلا نبدأ!',
    'goalDetail.title': 'الهدف',
    'myRewards.bonusHint': 'الدقايق دي بتنتهي لوحدها بعد شوية.',
    'myRewards.bonusMinutes': 'دقيقة زيادة فعّالة',
    'myRewards.bonusSection': 'وقت زيادة',
    'myRewards.emptyBody': 'خلّص هدف واحد وهتلاقي أول جايزة هنا.',
    'myRewards.emptyTitle': 'لسه مفيش جوايز',
    'myRewards.errorTitle': 'مقدرناش نجيب جوايزك',
    'myRewards.grantActive': 'شغّالة',
    'myRewards.grantFinished': 'خلصت',
    'myRewards.grantMinutes': '{{count}} دقيقة',
    'myRewards.loading': 'بنجيب جوايزك…',
    'myRewards.noPrizes': 'لسه مفيش جوايز مستنية.',
    'myRewards.prizeDelivered': 'استلمتها',
    'myRewards.prizeWaiting': 'مستنية',
    'myRewards.prizesHint': 'الجوايز دي محتاجة حد كبير يسلّمهالك.',
    'myRewards.openStore': 'افتح المتجر',
    'myRewards.prizesSection': 'جوايزي',
    'myRewards.title': 'جوايزي',
    'progress.badgesComingSoon': 'الشارات لسه في الطريق. لحد ما تيجي، خلّي عينك على التتابع فوق.',
    'progress.badgesSection': 'الشارات',
    'progress.emptyBody': 'أول ما تخلّص هدف، هتلاقي نقطك وتتابعك هنا.',
    'progress.emptyTitle': 'لسه في الأول',
    'progress.errorTitle': 'مقدرناش نجيب تقدّمك',
    'progress.level': 'المستوى',
    'progress.loading': 'بنحسب تقدّمك…',
    'progress.openAttempts': 'شوف محاولاتي',
    'progress.points': 'نقطة',
    'progress.pointsSection': 'نقطي',
    'progress.pointsUnavailable': 'رصيد النقط مش ظاهر دلوقتي.',
    'progress.streakDays': '{{count}} يوم',
    'progress.streaksHint': 'كل يوم بتخلّص فيه هدف، التتابع بيكبر.',
    'progress.streaksNoneYet': 'لسه مبدأتش تتابع — النهاردة فرصة!',
    'progress.streaksSection': 'تتابعي',
    'progress.streaksUnavailable': 'التتابع مش ظاهر دلوقتي.',
    'progress.title': 'تقدّمي',
    'rewardType.BADGE': 'شارة',
    'rewardType.COINS': 'كوينز',
    'rewardType.CUSTOM_REWARD': 'مكافأة تختارها',
    'rewardType.DIGITAL_REWARD': 'مكافأة رقمية',
    'rewardType.PARENT_APPROVAL_REWARD': 'موافقة خاصة',
    'rewardType.PHYSICAL_REWARD': 'مكافأة ملموسة',
    'rewardType.POINTS': 'نقاط',
    'rewardType.PRIVILEGE': 'امتياز',
    'rewardType.SCREEN_TIME': 'وقت شاشة إضافي',
    'rewardType.XP': 'نقاط خبرة',
    'rewardType.unknown': 'مكافأة',
    'session.done': 'خلّصت!',
    'session.foregroundNote': 'الوقت بيعدّ وإنت فاتح التطبيق بس.',
    'session.notNowTitle': 'مش دلوقتي',
    'session.noteHint': 'حد كبير هيقراها.',
    'session.noteLabel': 'عايز تقول حاجة؟ (اختياري)',
    'session.ofTarget': 'من {{count}} دقيقة',
    'session.parentWillSee': 'حد كبير هيبصّ عليها ويقرّر.',
    'session.quizNotReady': 'الاختبار لسه مش جاهز في النسخة دي. هنبعت محاولتك لحد كبير يشوفها.',
    'session.quizTitle': 'اختبار قصير',
    'session.selfConfirm': 'خلّصت الهدف',
    'session.selfConfirmHint': 'قول الحقيقة — دي بينك وبين نفسك.',
    'session.sendToParent': 'ابعتها لحد كبير',
    'session.serverWillCheck': 'هنتأكد الأول، وبعدين تيجي الجايزة.',
    'session.somethingHappenedTitle': 'حصلت حاجة صغيرة',
    'session.targetReached': 'كمّلت الوقت!',
    'session.title': 'شغّال عليه',
    // SPRINT F1 — المصرية العامية، وكل جملة بتقول للطفل الخطوة الجاية مش
    // الغلط اللي حصل. ولا واحدة منها بتقول إن الدليل «اتقبل»: «اتبعت» بس،
    // لأن اللي بيقرّر حد كبير.
    'session.evidence.artifactHow': 'صوّر اللي عملته، أو اختار صورة عندك خلاص.',
    'session.evidence.camera': 'صوّرها',
    'session.evidence.cancelRecording': 'ابدأ من الأول',
    'session.evidence.captureFailed': 'الموبايل مقدرش يعمل الملف المرة دي. جرّب تاني.',
    'session.evidence.document': 'اختار ملف',
    'session.evidence.gallery': 'من صوري',
    'session.evidence.micDenied': 'الميكروفون مقفول، فمش هنقدر نسجّل هنا. تقدر تسمّع لحد كبير — هو اللي بيقرّر أصلاً.',
    'session.evidence.micWhy': 'هنطلب نستخدم الميكروفون عشان نسجّل تسميعك. مفيش حاجة بتتسجّل غير لما تدوس الزرار.',
    'session.evidence.none': 'لسه مبعتش حاجة.',
    'session.evidence.notAttachedYet': 'تقدر تبعتها برضه — حد كبير هيشوف إن مفيش تسجيل معاها.',
    'session.evidence.recitationHow': 'سجّل تسميعك. إحنا بنبعت التسجيل، وحد كبير يسمعه ويقرّر.',
    'session.evidence.record': 'ابدأ التسجيل',
    'session.evidence.recording': 'بنسجّل… {{time}}',
    'session.evidence.replace': 'ابعت حاجة تانية',
    'session.evidence.stop': 'خلّصت تسميع',
    'session.evidence.stored': 'اتبعت: {{name}}',
    'session.evidence.storedHint': 'حد كبير هيشوفها بعد ما تدوس الزرار اللي تحت.',
    'session.evidence.tooLarge': 'الملف ده أكبر من {{mb}} ميجا، فمش هيعدّي. سجّل جزء أقصر، أو ابعت صورة واحدة.',
    'session.evidence.tooSmall': 'الملف ده فاضي تقريبًا. اتأكد إن التسجيل بدأ وجرّب تاني.',
    'session.evidence.typeUnknown': 'مش عارفين الملف ده نوعه إيه. جرّب تسجيل صوت أو صورة.',
    'session.evidence.typeWrongArtifact': 'ده محتاج صورة أو ملف يبيّن شغلك، مش تسجيل صوت.',
    'session.evidence.typeWrongRecitation': 'ده محتاج تسجيل صوت لتسميعك، مش صورة.',
    'session.evidence.uploadFailedTitle': 'معدّاش',
    'session.evidence.uploading': 'بنبعت…',
    'session.uploadTitle': 'تسميع أو صورة',
    'shell.coach': 'مدرّبي',
    'shell.deviceSettings': 'إعدادات الجهاز',
    'shell.myGrowth': 'نموّي',
    'shell.progress': 'تقدّمي',
    'shell.rewards': 'جوايزي',
    'shell.today': 'النهاردة',
    'streak.behaviour': 'السلوك',
    'streak.exercise': 'الرياضة',
    'streak.learning': 'التعلّم',
    'streak.quran': 'القرآن',
    'streak.reading': 'القراءة',
    'today.allDoneForNow': 'خلّصت اللي عليك دلوقتي. برافو!',
    'today.allDomains': 'كل حاجة',
    'today.chooseDomain': 'إيه اللي عايز تتعلمه النهاردة؟',
    'today.domainEmpty': 'لسه مفيش هدف في المجال ده — كلّم ولي أمرك.',
    'today.emptyBody': 'اطلب من حد كبير يضيف لك هدف — وارجع تبدأه.',
    'today.emptyTitle': 'مفيش أهداف النهاردة',
    'today.errorTitle': 'مقدرناش نجيب أهدافك',
    'today.loading': 'بنجيب أهدافك…',
    'today.notNow': 'مش دلوقتي — نشوفك بعدين!',
    'today.pointsReward': '{{count}} نقطة',
    'today.readyCount': 'عندك {{count}} جاهزين دلوقتي!',
    'today.readyNow': 'جاهز دلوقتي',
    'today.screenTimeReward': '{{count}} دقيقة زيادة',
    'today.title': 'أهداف النهاردة',
    'verifyForKid.ASSESSMENT_SCORE': 'هنستعمل آخر درجة ليك في المادة.',
    'verifyForKid.CODE_CHALLENGE': 'الكود بتاعك لازم ينجح في الاختبارات.',
    'verifyForKid.COMPLETION_ARTIFACT': 'ابعت حاجة تبيّن إنك عملته.',
    'verifyForKid.DURATION': 'هنعدّ الوقت اللي تقضيه هنا وإنت شغّال.',
    'verifyForKid.DURATION_PLUS_QUIZ': 'وقت هنا، وكمان كام سؤال.',
    'verifyForKid.PARENT_CONFIRMATION': 'حد كبير هيبصّ ويقرّر.',
    'verifyForKid.QUIZ': 'كام سؤال صغيرين في الآخر.',
    'verifyForKid.RECITATION_SUBMISSION': 'إنت تسمّع، وحد كبير يسمعك.',
    'verifyForKid.SELF_CHECK': 'إنت اللي هتقول لنا خلّصت.',
    'verifyForKid.unknown': 'أول ما تخلّص، هتتراجع.',
    'common.error': 'حصل خطأ.',
    'common.retry': 'حاول تاني',
    'common.done': 'تمام!',
    'common.checking': 'بنتأكد...',

    'pairing.title': 'يلا نبدأ!',
    'pairing.instruction': 'اطلب من حد كبير الكود من تطبيقه، وبعدين اكتبه تحت.',
    'pairing.codeHint': 'XXXX-XXXX',
    'pairing.codeLabel': 'كود الاقتران',
    'pairing.codeNotAccepted':
        'الكود ده مش شغّال. اطلب من حد كبير يتأكد منه، أو يعملك كود جديد.',
    'pairing.cannotReach':
        'مش منك \u2014 مش قادرين نوصل دلوقتي. جرّب تاني بعد شوية.',
    'pairing.submit': 'يلا بينا!',

    'myGrowth.title': 'نموّي',
    'myGrowth.logWater': 'سجّل مية',
    'myGrowth.habitDone': 'حلو! "{{title}}" خلصت!',
    'myGrowth.hydrationDone': 'برافو عليك، بتشرب مية كويس!',
    'myGrowth.faithDone': 'برافو! "{{title}}" خلصت!',
    'myGrowth.studyDone': 'حلو إنك ذاكرت النهاردة!',
    'myGrowth.logActivity': 'سجّل ٢٠ دقيقة',
    'myGrowth.activityDone': 'برافو! اتحركت النهاردة.',
    'myGrowth.smartTaskAccept': 'هعملها',
    'myGrowth.smartTaskDismiss': 'مش دلوقتي',
    'myGrowth.healthTitle': 'صحتي',
    'myGrowth.learningTitle': 'تعليمي',
    'myGrowth.waterLabel': 'المية',
    'myGrowth.activityLabel': 'النشاط',
    'myGrowth.achievedLabel': 'تم',
    'myGrowth.millilitresUnit': 'مل',
    'myGrowth.minutesUnit': 'دقيقة',
    'myGrowth.newLabel': 'جديد',
    'myGrowth.ringAllDone': 'أنهيت كل شيء اليوم!',
    'myGrowth.ringAllDoneLabel': 'اكتمل كل شيء',
    'myGrowth.ringGreeting': 'أهلًا يا {{name}}!',
    'myGrowth.ringGreetingAllDone': 'أحسنت يا {{name}}!',
    'myGrowth.ringKeepGoing': 'هيا نكمل قائمة اليوم!',
    'myGrowth.ringNothingYet': 'لا يوجد شيء اليوم بعد.',
    'myGrowth.xp': 'نقاط الخبرة',
    'myGrowth.coins': 'كوينز',
    'myGrowth.level': 'المستوى',
    'myGrowth.learningStreak': 'تتابع {{count}} يوم!',
    'myGrowth.learningNoStreak': 'ابدأ تتابع مذاكرتك النهاردة',
    'myGrowth.sessionsCount': '{{count}} جلسة (30 يوم)',
    'myGrowth.studyNow': 'ذاكر دلوقتي',
    'myGrowth.loadError': 'ياااه! حاجة ما حمّلتش.',
    'myGrowth.tryAgainPrompt': 'يلا نجرب تاني!',
    'myGrowth.tryAgain': 'حاول تاني',
    'myGrowth.messages': 'الرسايل',
    'myGrowth.myHabits': 'عاداتي',
    'myGrowth.faith': 'الإيمان',
    'myGrowth.noHabitsYet': 'لسه مفيش عادات — اطلب من حد كبير يضيف واحدة!',
    'myGrowth.noPracticesYet': 'لسه مفيش ممارسات — اطلب من حد كبير يضيف واحدة!',
    'myGrowth.noMessagesYet': 'لسه مفيش رسايل — هتوصلك هنا.',
    'myGrowth.done': 'تمام!',

    'rewards.title': 'جوايزي',
    'rewards.storeTitle': 'متجر الجوايز',
    'rewards.requested': 'يـاي! طلبت "{{title}}" — اطلب من حد كبير يوافق عليها!',
    'rewards.coins': '{{count}} كوينز',
    'rewards.redeemFailed': 'معرفناش نطلبها دلوقتي — جرّب تاني!',
    'rewards.noRewardsYet': 'لسه مفيش جوايز — اطلب من حد كبير يضيف شوية!',
    'rewards.loadError': 'ياااه! حاجة ما حمّلتش.',
    'rewards.tryAgain': 'حاول تاني',
    'rewards.coinsLabel': 'كوينز',
    'rewards.getIt': 'هاتها!',
    'rewards.askAnyway': 'ناقصك {{count}} كوينز — اطلبها برضه، ممكن حد كبير يساعدك!',

    'deviceStatus.title': 'حالة الجهاز',
    'deviceStatus.pairedHeartbeat': '✅ الجهاز متربط. بينبض بانتظام.',
    'deviceStatus.myGrowth': 'نموّي',
    'deviceStatus.myRewards': 'جوايزي',
    'deviceStatus.runtimeStatus': 'حالة التشغيل',
    'deviceStatus.diagnostics': 'التشخيص',
    'deviceStatus.permissions': 'الأذونات',
    'deviceStatus.capabilities': 'الإمكانيات',
    'deviceStatus.syncCapabilities': 'زامن الإمكانيات دلوقتي',
    'deviceStatus.syncSuccess': 'تم المزامنة ✅',
    'deviceStatus.syncFailed': 'فشلت المزامنة — هنحاول تاني بعد شوية.',
    'deviceStatus.memoryUsage': 'استخدام الذاكرة: {{mb}} ميجا',
    'deviceStatus.battery': 'البطارية: {{percent}}%',
    'deviceStatus.batteryUnknown': 'غير معروف',
    'deviceStatus.healthNormal': 'طبيعي',
    'deviceStatus.healthAttention': 'يحتاج انتباه',
    'deviceStatus.healthLabel': 'الحالة: {{status}}',
    'deviceStatus.fix': 'إصلاح',
    'deviceStatus.protectionActive': 'كل حاجة مظبوطة',
    'deviceStatus.protectionNotActive': 'فاضل خطوة واحدة',
    'deviceStatus.accessibilityOff': 'فيه إعداد محتاج حد كبير يفتحه',
    'deviceStatus.noPolicySynced': 'لسه ما اتزامنّاش مع عيلتك',
    'deviceStatus.enforcingPolicy': 'شغّال مع خطة عيلتك',
    'deviceStatus.queuedUpdates': 'في {{count}} تحديث/تحديثات مستنية تتزامن (أوفلاين)',

    // F2: أسماء الأذونات كما يراها الطفل وولي الأمر. مصطلح
    // «Accessibility Service» مصطلح منصّة لا يعرفه أحد منهما.
    'permissions.usageAccess': 'استخدام التطبيقات',
    'permissions.accessibilityService': 'معرفة التطبيق المفتوح',
    'permissions.overlay': 'إظهار شاشة الاستراحة',
    'permissions.batteryOptimization': 'الاستمرار في العمل بالخلفية',
    'permissions.notifications': 'الإشعارات',

    // ==================================================================
    // F2 — الإفصاح البارز (Prominent Disclosure) — سياسة Play، تدقيق
    // A3 §4/P2 وخطر R5. تظهر مرة واحدة عند أول تشغيل، قبل الاقتران وقبل
    // طلب أي إذن حسّاس.
    //
    // السجل اللغوي هنا فصحى مبسّطة، لا عامية — بعكس بقية شاشات الطفل.
    // السبب: هذه شاشة موافقة يقرؤها ولي الأمر أثناء الإعداد (ولا يستطيع
    // الطفل منح إذن Accessibility وحده أصلًا)، ويقرؤها كذلك مراجع Play.
    // الفارق مقصود ومسجَّل في تقرير F2.
    //
    // كل حقل مذكور أدناه حقل يرسله الكود فعلًا — القائمة مأخوذة حرفيًا
    // من حمولة daily-summary في digital_wellbeing_service.dart، لا من
    // وصف تسويقي لها.
    // ==================================================================
    'disclosure.title': 'قبل أن نبدأ',
    'disclosure.intro':
        '«ابني» يساعد الأسرة على الاتفاق على خطة صحية لوقت الشاشة. ولكي يقوم بذلك، يرسل هذا الجهاز ملخّصًا يوميًا إلى حساب الأسرة. هذا محتواه بالضبط.',
    'disclosure.dataHeading': 'ما الذي يرسله هذا الجهاز يوميًا',
    'disclosure.dataUsageDate': 'تاريخ الملخّص.',
    'disclosure.dataTotalScreenMinutes': 'إجمالي دقائق استخدام الشاشة.',
    'disclosure.dataAppBreakdown': 'أسماء التطبيقات المستخدَمة وعدد دقائق كل منها، وتصنيف كل تطبيق (تعليم، ألعاب، أخرى).',
    'disclosure.dataPickupCount': 'عدد مرات فتح الهاتف.',
    'disclosure.dataNightUsageMinutes': 'دقائق الاستخدام الليلي (من العاشرة مساءً حتى السادسة صباحًا).',
    'disclosure.dataBlockedAttemptCount': 'عدد مرات فتح تطبيق خارج خطة اليوم.',
    'disclosure.dataSessionCount': 'عدد جلسات الاستخدام.',
    'disclosure.dataAverageSessionMinutes': 'متوسط طول الجلسة.',
    'disclosure.dataLongestSessionMinutes': 'طول أطول جلسة.',
    'disclosure.notCollectedHeading': 'ما الذي لا يُجمَع إطلاقًا',
    'disclosure.notCollectedContent': 'لا شيء مما يظهر على الشاشة: لا رسائل، ولا صور، ولا كلمات مرور، ولا ما يُكتَب.',
    'disclosure.notCollectedAudio': 'لا ميكروفون، ولا كاميرا، ولا محتوى مكالمات أو رسائل.',
    'disclosure.notCollectedLocation': 'لا موقع جغرافي.',
    'disclosure.whoSees': 'يراه فقط ولي الأمر صاحب حساب الأسرة. لا يُباع ولا يُشارَك لأغراض إعلانية.',
    'disclosure.control': 'يستطيع ولي الأمر الاطلاع على هذه البيانات أو تصديرها أو حذفها في أي وقت.',
    'disclosure.privacyPolicy': 'اقرأ سياسة الخصوصية كاملة',
    'disclosure.accept': 'فهمت — نكمل',
    'disclosure.decline': 'ليس الآن',
    'disclosure.declined': 'لا مشكلة. لم يُرسَل أي شيء. تستطيع العودة في أي وقت.',
    'disclosure.declinedAction': 'اقرأ مرة أخرى',

    // ------------------------------------------------------------------
    // F2 — شاشة التمهيد قبل إذن Accessibility (سياسة Play، البندان
    // P1 وP2). تظهر قبل شاشة النظام في كل مرة نوجّه المستخدم إليها.
    // صادقة ومحدَّدة وغير مخيفة — لا تذكر «تجسّس» ولا «مراقبة».
    // ------------------------------------------------------------------
    'priming.title': 'خطوة أخيرة لتعمل الخطة',
    'priming.what': 'يطلب أندرويد إذنك أولًا حتى يعرف «ابني» أي تطبيق مفتوح الآن.',
    'priming.reads': 'ما الذي يُقرأ: اسم التطبيق المفتوح في هذه اللحظة. لا أكثر.',
    'priming.doesNotRead': 'ما الذي لا يُقرأ: أي شيء معروض على الشاشة — لا رسائل، ولا كلمات مرور، ولا ما يُكتَب. الخدمة مضبوطة بحيث لا تستطيع ذلك تقنيًا.',
    'priming.why': 'بدون هذا الإذن لا تستطيع خطة اليوم ولا وقت النوم أن تبدأ في وقتهما الصحيح.',
    'priming.stepsHeading': 'في الشاشة التالية',
    'priming.step1': 'ابحث عن «ابني — خطة وقت الشاشة» في القائمة.',
    'priming.step2': 'فعّلها ثم أكّد.',
    'priming.step3': 'ارجع إلى هنا — ستتحول الحالة إلى اللون الأخضر وحدها.',
    'priming.reversible': 'تستطيع إيقافها من الشاشة نفسها متى شئت.',
    'priming.open': 'افتح الإعدادات',
    'priming.later': 'ليس الآن',

    // ------------------------------------------------------------------
    // G18 — شاشة التمهيد قبل إذن الإشعارات (POST_NOTIFICATIONS).
    //
    // تظهر قبل نافذة النظام في أندرويد 13+ مباشرةً، ولا تظهر أبدًا عند
    // فتح التطبيق أول مرة. أندرويد يعرض تلك النافذة مرتين على الأكثر في
    // عمر التطبيق كله، لذا إظهارها لطفل لا يعرف ما المطلوب منه يُهدر
    // فرصة لا تعود.
    //
    // النبرة: تُخبر الطفل بما سيصله هو (أخبار مكافآته، تنبيه قبل وقت
    // النوم) لا بما يريده التطبيق، ولا تَعِد بشيء لا يفعله التطبيق: لا
    // إعلانات، ولا رسالة تلوم الطفل، والرفض مقبول تمامًا — وفق
    // CONTEXT §3.7 (غير عقابي).
    // ------------------------------------------------------------------
    'notifPriming.title': 'هل تسمح لـ«ابني» أن يرسل لك رسائل صغيرة؟',
    'notifPriming.what': 'يريد «ابني» أن يرسل إلى هذا الهاتف رسائل قصيرة — سطر أو سطران، لا أكثر.',
    'notifPriming.example1': 'عندما تكسب مكافأة جديدة.',
    'notifPriming.example2': 'تنبيه لطيف قبل أن يبدأ وقت الهدوء، حتى لا يتوقف شيء فجأة في وسط اللعب.',
    'notifPriming.example3': '«أحسنت» عندما تُنهي شيئًا خطّطت له.',
    'notifPriming.why': 'بدون هذا الإذن يُخفي أندرويد كل هذه الرسائل، ولن تعرف بها إلا إذا فتحت التطبيق بنفسك.',
    'notifPriming.noSpam': 'لا إعلانات، ولا رسالة تلومك أبدًا. وتستطيع إيقافها متى شئت.',
    'notifPriming.allow': 'نعم، أرسلها',
    'notifPriming.later': 'ليس الآن',
    'notifPriming.granted': 'تمّ — يستطيع «ابني» أن يرسل لك رسائل الآن.',
    'notifPriming.denied': 'لا مشكلة. كل شيء آخر يعمل كما هو، لكن لن تصلك رسائل. تستطيع تشغيلها في أي وقت من هذه الشاشة.',
    'notifPriming.permanentlyDenied': 'لن يسأل أندرويد مرة أخرى، لذا يجب تشغيل الرسائل من إعدادات الهاتف.',
    'notifPriming.openSettings': 'افتح الإعدادات',

    // ------------------------------------------------------------------
    // F2 — خطوة إعدادات الشركة المصنّعة (خطر R7).
    // النبرة: لا تُخيف الطفل ولا تلومه. المشكلة في إعداد المصنع، لا فيه.
    // ------------------------------------------------------------------
    'oem.title': 'خلّي الخطة شغّالة',
    'oem.intro': 'بعض الهواتف تغلق التطبيقات العاملة في الخلفية لتوفير البطارية. حين يحدث ذلك تتوقف خطة اليوم بهدوء دون أن يلاحظ أحد. إعداد واحد يمنع هذا.',
    'oem.reassure': 'هذا لا يستهلك بطارية إضافية — هو فقط يمنع الهاتف من إيقاف «ابني» من تلقاء نفسه.',
    'oem.stepsHeading': 'في الشاشة التالية',
    'oem.step.xiaomi': 'افتح «التشغيل التلقائي» (Autostart)، ابحث عن «ابني» وفعّله. ثم من «موفّر البطارية» اختر «بلا قيود».',
    'oem.step.oppo': 'فعّل «السماح بالتشغيل التلقائي» لتطبيق «ابني»، ثم اضبط استهلاك الطاقة في الخلفية على «مسموح».',
    'oem.step.vivo': 'فعّل «التشغيل التلقائي» لتطبيق «ابني»، وأضِفه إلى قائمة السماح باستهلاك الطاقة في الخلفية.',
    'oem.step.huawei': 'افتح «تشغيل التطبيقات»، وحوّل «ابني» إلى «إدارة يدوية»، ثم فعّل المفاتيح الثلاثة.',
    'oem.step.samsung': 'ابحث عن «ابني» في قائمة البطارية وأوقف «إنامة التطبيق»، أو أخرجه من قائمة «التطبيقات النائمة».',
    'oem.step.transsion': 'افتح «إدارة التشغيل التلقائي» داخل PhoneMaster واسمح لتطبيق «ابني» بالعمل تلقائيًا.',
    'oem.step.generic': 'ابحث عن «ابني» في القائمة واسمح له بالاستمرار في العمل في الخلفية.',
    'oem.open': 'افتح شاشة الإعدادات',
    'oem.done': 'تم',
    'oem.skip': 'تخطَّ الآن',
    'oem.openedOemAutostart': 'هذه هي الشاشة الصحيحة — ابحث عن «ابني» في القائمة.',
    'oem.openedBatteryOptimization': 'هذا الهاتف لا يملك قائمة تشغيل تلقائي، ففتحنا شاشة البطارية بدلًا منها. اضبط «ابني» على «بلا قيود».',
    'oem.openedAppDetails': 'فتحنا صفحة إعدادات التطبيق. ادخل إلى «البطارية» ثم اسمح بالعمل في الخلفية.',
    'oem.openedNone': 'لم يسمح لنا هذا الهاتف بفتح تلك الشاشة. تجدها في الإعدادات > البطارية.',
    'oem.deviceLabel': 'هاتفك: {{manufacturer}}',
  },
};

/// ARABIC IS THE DEFAULT, not English (audit MA-016).
///
/// CONTEXT §1 makes Arabic the product's FIRST language for the first two
/// markets (Egypt, then Saudi Arabia) — "RTL حقيقي، لا ترجمة". Shipping
/// `AppLocale.en` here meant every child and every parent in those markets
/// opened the app in English and had to go find a language switch, which
/// is the exact opposite of the stated positioning.
///
/// This constant is also the FALLBACK used by `translate()` when a key is
/// missing from the requested locale. Both apps currently have full ar/en
/// key parity, so the flip does not change any resolved string today; if
/// parity ever breaks, an untranslated key now falls back to Arabic rather
/// than surfacing English inside an otherwise-Arabic screen.
const AppLocale defaultLocale = AppLocale.ar;
const List<AppLocale> rtlLocales = [AppLocale.ar];

bool isRtl(AppLocale locale) => rtlLocales.contains(locale);

/// Stable, persistable code for an [AppLocale]. Deliberately the plain
/// ISO-639-1 code so what is written to storage matches what
/// `Locale.languageCode` and Android's `values-<code>` resource
/// qualifiers use — one vocabulary across the whole stack.
String appLocaleCode(AppLocale locale) => switch (locale) {
      AppLocale.en => 'en',
      AppLocale.ar => 'ar',
    };

/// Inverse of [appLocaleCode]. Returns `null` for anything unsupported so
/// callers can decide their own fallback, rather than silently pretending
/// an unknown language is the default.
AppLocale? appLocaleFromCode(String? code) => switch (code) {
      'en' => AppLocale.en,
      'ar' => AppLocale.ar,
      _ => null,
    };

String _resolvePluralKey(String key, int? count, Map<String, String> resources) {
  if (count == null) return key;
  final suffix = count == 1 ? '_one' : '_other';
  final pluralKey = '$key$suffix';
  return resources.containsKey(pluralKey) ? pluralKey : key;
}

String _interpolate(String template, Map<String, Object>? options) {
  if (options == null) return template;
  var result = template;
  for (final entry in options.entries) {
    result = result.replaceAll('{{${entry.key}}}', entry.value.toString());
  }
  return result;
}

/// IS THIS KEY REAL? — and the reason a child app needs to be able to ask.
///
/// [translate]'s last resort is THE KEY ITSELF, which is the right answer for
/// a missing piece of app chrome (a visible `today.title` on one screen is a
/// bug report) and the WRONG one for a key assembled at runtime from a server
/// value: `t('attemptStage.${attempt.status}')` and `t('category.${goal
/// .category}')` are built from open strings the backend can widen at any
/// time — `status` is a plain `VarChar(20)` — so an unmapped value renders
/// «attemptStage.CANCELLED» to a nine-year-old. That is a backend status code
/// on a child's screen, which this product does not do.
///
/// Callers pair this with a real fallback; see `LocaleController.tOrElse`.
bool hasTranslation(AppLocale locale, String key) =>
    (_resources[locale] ?? const <String, String>{}).containsKey(key) ||
    _resources[defaultLocale]!.containsKey(key);

/// Same fallback strategy as Parent App/Dashboard's own translate():
/// requested locale -> default locale -> the raw key itself (never blank).
String translate(AppLocale locale, String key, {int? count, Map<String, Object>? options}) {
  final resources = _resources[locale] ?? _resources[defaultLocale]!;
  final resolvedKey = _resolvePluralKey(key, count, resources);

  final template = resources[resolvedKey] ?? _resources[defaultLocale]![resolvedKey] ?? key;

  final interpolationOptions = <String, Object>{if (count != null) 'count': count, ...?options};
  return _interpolate(template, interpolationOptions);
}
