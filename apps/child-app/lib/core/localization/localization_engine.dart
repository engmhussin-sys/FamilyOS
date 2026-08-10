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
    'pairing.codeHint': 'XXXX-XXXX',
    'pairing.genericError': "Something went wrong. Let's try again!",
    'pairing.submit': "Let's Go!",

    'myGrowth.title': 'My Growth',
    'myGrowth.logWater': 'Log water',
    'myGrowth.habitDone': 'Awesome! "{{title}}" done!',
    'myGrowth.hydrationDone': 'Great job staying hydrated!',
    'myGrowth.faithDone': 'Well done! "{{title}}" complete!',
    'myGrowth.studyDone': 'Nice work studying today!',
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
  },
  AppLocale.ar: {
    'common.error': 'حصل خطأ.',
    'common.retry': 'حاول تاني',
    'common.done': 'تمام!',
    'common.checking': 'بنتأكد...',

    'pairing.title': 'يلا نبدأ!',
    'pairing.instruction': 'اطلب من حد كبير الكود من تطبيقه، وبعدين اكتبه تحت.',
    'pairing.codeHint': 'XXXX-XXXX',
    'pairing.genericError': 'حصل حاجة غلط. يلا نجرب تاني!',
    'pairing.submit': 'يلا بينا!',

    'myGrowth.title': 'نموّي',
    'myGrowth.logWater': 'سجّل مية',
    'myGrowth.habitDone': 'حلو! "{{title}}" خلصت!',
    'myGrowth.hydrationDone': 'برافو عليك، بتشرب مية كويس!',
    'myGrowth.faithDone': 'برافو! "{{title}}" خلصت!',
    'myGrowth.studyDone': 'حلو إنك ذاكرت النهاردة!',
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
  },
};

const AppLocale defaultLocale = AppLocale.en;
const List<AppLocale> rtlLocales = [AppLocale.ar];

bool isRtl(AppLocale locale) => rtlLocales.contains(locale);

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
