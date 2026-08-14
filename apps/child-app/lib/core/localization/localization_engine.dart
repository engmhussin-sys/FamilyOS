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
    'common.error': 'Something went wrong.',
    'common.retry': 'Try Again',
    'common.done': 'Done!',
    'common.checking': 'Checking...',

    'pairing.title': "Let's get set up!",
    'pairing.instruction': 'Ask a grown-up for the code from their app, then type it in below.',
    'pairing.codeLabel': 'Pairing code',
    'pairing.codeHint': 'XXXX-XXXX',
    'pairing.genericError': "Something went wrong. Let's try again!",
    'pairing.submit': "Let's Go!",

    'myGrowth.title': 'My Growth',
    'myGrowth.logWater': 'Log water',
    'myGrowth.habitDone': 'Awesome! "{{title}}" done!',
    'myGrowth.hydrationDone': 'Great job staying hydrated!',
    'myGrowth.faithDone': 'Well done! "{{title}}" complete!',
    'myGrowth.studyDone': 'Nice work studying today!',
    'myGrowth.smartTaskAccept': "I'll do it",
    'myGrowth.smartTaskDismiss': 'Not now',
    'myGrowth.healthTitle': 'My Health',
    'myGrowth.learningTitle': 'My Learning',
    'myGrowth.waterLabel': 'Water',
    'myGrowth.activityLabel': 'Activity',
    'myGrowth.minutesUnit': 'min',
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
    'rewards.xpLabel': 'XP',
    'rewards.getIt': 'Get it!',
    'rewards.needMore': 'Need more',

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
    'deviceStatus.protectionActive': 'Protection is active',
    'deviceStatus.protectionNotActive': 'Protection is not fully active',
    'deviceStatus.accessibilityOff': 'Accessibility Service is turned off',
    'deviceStatus.noPolicySynced': 'No policy has synced yet',
    'deviceStatus.enforcingPolicy': 'Enforcing the current policy',
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
    'common.error': 'حصل خطأ.',
    'common.retry': 'حاول تاني',
    'common.done': 'تمام!',
    'common.checking': 'بنتأكد...',

    'pairing.title': 'يلا نبدأ!',
    'pairing.instruction': 'اطلب من حد كبير الكود من تطبيقه، وبعدين اكتبه تحت.',
    'pairing.codeHint': 'XXXX-XXXX',
    'pairing.codeLabel': 'كود الاقتران',
    'pairing.genericError': 'حصل حاجة غلط. يلا نجرب تاني!',
    'pairing.submit': 'يلا بينا!',

    'myGrowth.title': 'نموّي',
    'myGrowth.logWater': 'سجّل مية',
    'myGrowth.habitDone': 'حلو! "{{title}}" خلصت!',
    'myGrowth.hydrationDone': 'برافو عليك، بتشرب مية كويس!',
    'myGrowth.faithDone': 'برافو! "{{title}}" خلصت!',
    'myGrowth.studyDone': 'حلو إنك ذاكرت النهاردة!',
    'myGrowth.smartTaskAccept': 'هعملها',
    'myGrowth.smartTaskDismiss': 'مش دلوقتي',
    'myGrowth.healthTitle': 'صحتي',
    'myGrowth.learningTitle': 'تعليمي',
    'myGrowth.waterLabel': 'المية',
    'myGrowth.activityLabel': 'النشاط',
    'myGrowth.minutesUnit': 'دقيقة',
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
    'rewards.xpLabel': 'نقاط خبرة',
    'rewards.getIt': 'هاتها!',
    'rewards.needMore': 'محتاج أكتر',

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
    'deviceStatus.protectionActive': 'الحماية شغّالة',
    'deviceStatus.protectionNotActive': 'الحماية مش شغّالة بالكامل',
    'deviceStatus.accessibilityOff': 'خدمة الوصول متوقفة',
    'deviceStatus.noPolicySynced': 'لسه مفيش سياسة اتزامنت',
    'deviceStatus.enforcingPolicy': 'بتطبّق السياسة الحالية',
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

/// Same fallback strategy as Parent App/Dashboard's own translate():
/// requested locale -> default locale -> the raw key itself (never blank).
String translate(AppLocale locale, String key, {int? count, Map<String, Object>? options}) {
  final resources = _resources[locale] ?? _resources[defaultLocale]!;
  final resolvedKey = _resolvePluralKey(key, count, resources);

  final template = resources[resolvedKey] ?? _resources[defaultLocale]![resolvedKey] ?? key;

  final interpolationOptions = <String, Object>{if (count != null) 'count': count, ...?options};
  return _interpolate(template, interpolationOptions);
}
