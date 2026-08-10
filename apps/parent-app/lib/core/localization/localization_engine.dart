/// Mirrors apps/admin-dashboard/src/shared/i18n/localizationEngine.ts's
/// design exactly: fallback strategy (requested locale -> default locale
/// -> the raw key itself), simple `_one`/`_other` pluralization,
/// interpolation via `{{token}}`. Resources are embedded as Dart const
/// maps rather than loaded from JSON assets — with no Flutter toolchain
/// available to verify `pubspec.yaml` asset bundling actually works in
/// this environment, embedding is the only path verifiable via static
/// review alone. Migrating to bundled `.arb`/JSON resources (matching
/// the Dashboard's approach exactly) is a real, trivial follow-up once
/// a real `flutter build` can confirm the asset pipeline works.
library;

enum AppLocale { en, ar }

const Map<AppLocale, Map<String, String>> _resources = {
  AppLocale.en: {
    'common.loading': 'Loading...',
    'common.error': 'Something went wrong.',
    'common.retry': 'Retry',
    'common.offlineBanner': 'No internet connection',
    'digitalTwin.title': 'Digital Twin',
    'digitalTwin.notARankingTool': 'A picture of your child\u2019s current progress across areas \u2014 not a score for ranking or comparing children.',
    'digitalTwin.growthScore': 'Growth Score',
    'digitalTwin.basedOnSubScores': 'Based on {{count}} of {{total}} available indicators',
    'digitalTwin.health': 'Health',
    'digitalTwin.learning': 'Learning',
    'digitalTwin.faith': 'Faith',
    'digitalTwin.habits': 'Habits',
    'digitalTwin.social': 'Social',
    'digitalTwin.behavior': 'Behavior',
    'digitalTwin.safety': 'Safety',
    'digitalTwin.notYetAvailable': 'Not yet available',
    'lifeTimeline.title': 'Life Timeline',
    'lifeTimeline.all': 'All',
    'lifeTimeline.empty': 'No milestones yet.',
    'lifeTimeline.category.health': 'Health',
    'lifeTimeline.category.learning': 'Learning',
    'lifeTimeline.category.faith': 'Faith',
    'lifeTimeline.category.rewards': 'Rewards',
    'lifeTimeline.category.safety': 'Safety',
    'lifeTimeline.category.habits': 'Habits',
    'lifeTimeline.category.family': 'Family',
    'habitTracker.title': 'Habits',
    'habitTracker.empty': 'No habits yet.',
    'habitTracker.shared': 'Shared',
    'habitTracker.markDone': 'Mark done',
    'healthTrend.title': 'Health',
    'healthTrend.score': 'Health Score',
    'healthTrend.hydration': 'Hydration',
    'healthTrend.activity': 'Activity',
    'healthTrend.sleep': 'Sleep',
    'healthTrend.meals': 'Meals logged',
    'healthTrend.minutes': 'min',
    'healthTrend.hours': 'hrs',
    'healthTrend.notLogged': 'Not logged',
    'healthTrend.logWater': 'Log water',
    'faithProgress.title': 'Faith',
    'faithProgress.empty': 'No practices yet.',
    'faithProgress.logToday': 'Log today',
    'familyStore.title': 'Family Store',
    'familyStore.empty': 'No rewards in the store yet.',
    'familyStore.coins': 'coins',
    'coaching.title': 'Coaching',
    'coaching.empty': 'No recommendations right now.',
    'coaching.track.parent': 'For you',
    'coaching.track.child': 'For your child',
    'coaching.track.family': 'For the family',
    'common.save': 'Save',
    'common.cancel': 'Cancel',
    'auth.loginTitle': 'Parent Login',
    'auth.email': 'Email',
    'auth.password': 'Password',
    'auth.login': 'Log In',
    'auth.noAccount': "Don't have an account?",
    'auth.createAccount': 'Create a new account',
    'auth.registerTitle': 'Create Your Family Account',
    'auth.fullName': 'Full Name',
    'auth.phone': 'Phone',
    'auth.register': 'Create Account',
    'auth.haveAccount': 'Already have an account?',
    'family.setupTitle': 'Set Up Your Family',
    'family.name': 'Family Name',
    'family.country': 'Country',
    'family.numberOfChildren': 'Number of Children',
    'family.continueButton': 'Continue',
    'dashboard.title': 'Home',
    'dashboard.familySummary': 'Family Summary',
    'dashboard.children': '{{count}} children',
    'dashboard.children_one': '{{count}} child',
    'dashboard.children_other': '{{count}} children',
    'dashboard.devices': '{{count}} devices',
    'dashboard.alerts': '{{count}} alerts',
    'dashboard.addChild': 'Add Child',
    'dashboard.viewReports': 'View Reports',
    'dashboard.notifications': 'Notifications',
    'dashboard.settings': 'Settings',
    'dashboard.online': 'Online',
    'dashboard.offline': 'Offline',
    'pairing.addChildTitle': 'Add a Child',
    'pairing.noChildrenYet': 'Add a child from your Dashboard first before pairing a device.',
    'pairing.selectChild': 'Select Child',
    'pairing.generateCode': 'Generate Pairing Code',
    'pairing.validFor': 'Valid for',
    'notifications.title': 'Notifications',
    'notifications.empty': 'No notifications yet.',
    'notifications.markAllRead': 'Mark all as read',
    'settings.title': 'Settings',
    'settings.language': 'Language',
    'settings.profile': 'Profile',
    'settings.subscription': 'Subscription',
    'settings.privacy': 'Privacy',
    'settings.logout': 'Log Out',
  },
  AppLocale.ar: {
    'common.loading': 'جارٍ التحميل...',
    'common.error': 'حدث خطأ ما.',
    'common.retry': 'إعادة المحاولة',
    'common.offlineBanner': 'لا يوجد اتصال بالإنترنت',
    'digitalTwin.title': 'التوأم الرقمي',
    'digitalTwin.notARankingTool': 'صورة لتقدّم طفلك الحالي عبر عدة مجالات — وليست درجة لتصنيف الأطفال أو مقارنتهم.',
    'digitalTwin.growthScore': 'مؤشر النمو',
    'digitalTwin.basedOnSubScores': 'بناءً على {{count}} من أصل {{total}} مؤشرات متاحة',
    'digitalTwin.health': 'الصحة',
    'digitalTwin.learning': 'التعلّم',
    'digitalTwin.faith': 'الإيمان',
    'digitalTwin.habits': 'العادات',
    'digitalTwin.social': 'الاجتماعي',
    'digitalTwin.behavior': 'السلوك',
    'digitalTwin.safety': 'الأمان',
    'digitalTwin.notYetAvailable': 'غير متاح بعد',
    'lifeTimeline.title': 'الخط الزمني للحياة',
    'lifeTimeline.all': 'الكل',
    'lifeTimeline.empty': 'لا توجد أحداث بعد.',
    'lifeTimeline.category.health': 'الصحة',
    'lifeTimeline.category.learning': 'التعلّم',
    'lifeTimeline.category.faith': 'الإيمان',
    'lifeTimeline.category.rewards': 'المكافآت',
    'lifeTimeline.category.safety': 'الأمان',
    'lifeTimeline.category.habits': 'العادات',
    'lifeTimeline.category.family': 'الأسرة',
    'habitTracker.title': 'العادات',
    'habitTracker.empty': 'لا توجد عادات بعد.',
    'habitTracker.shared': 'مشتركة',
    'habitTracker.markDone': 'تم الإنجاز',
    'healthTrend.title': 'الصحة',
    'healthTrend.score': 'مؤشر الصحة',
    'healthTrend.hydration': 'الترطيب',
    'healthTrend.activity': 'النشاط',
    'healthTrend.sleep': 'النوم',
    'healthTrend.meals': 'الوجبات المسجَّلة',
    'healthTrend.minutes': 'دقيقة',
    'healthTrend.hours': 'ساعة',
    'healthTrend.notLogged': 'غير مُسجَّل',
    'healthTrend.logWater': 'سجّل ماء',
    'faithProgress.title': 'الإيمان',
    'faithProgress.empty': 'لا توجد ممارسات بعد.',
    'faithProgress.logToday': 'سجّل اليوم',
    'familyStore.title': 'متجر الأسرة',
    'familyStore.empty': 'لا توجد مكافآت بالمتجر بعد.',
    'familyStore.coins': 'عملة',
    'coaching.title': 'التوجيه',
    'coaching.empty': 'لا توجد توصيات حاليًا.',
    'coaching.track.parent': 'لك',
    'coaching.track.child': 'لطفلك',
    'coaching.track.family': 'للأسرة',
    'common.save': 'حفظ',
    'common.cancel': 'إلغاء',
    'auth.loginTitle': 'دخول الوالدين',
    'auth.email': 'البريد الإلكتروني',
    'auth.password': 'كلمة المرور',
    'auth.login': 'دخول',
    'auth.noAccount': 'ليس لديك حساب؟',
    'auth.createAccount': 'إنشاء حساب جديد',
    'auth.registerTitle': 'إنشاء حساب العائلة',
    'auth.fullName': 'الاسم الكامل',
    'auth.phone': 'الهاتف',
    'auth.register': 'إنشاء الحساب',
    'auth.haveAccount': 'لديك حساب بالفعل؟',
    'family.setupTitle': 'إعداد عائلتك',
    'family.name': 'اسم العائلة',
    'family.country': 'الدولة',
    'family.numberOfChildren': 'عدد الأطفال',
    'family.continueButton': 'متابعة',
    'dashboard.title': 'الرئيسية',
    'dashboard.familySummary': 'ملخص العائلة',
    'dashboard.children_one': 'طفل واحد',
    'dashboard.children_other': '{{count}} أطفال',
    'dashboard.devices': '{{count}} أجهزة',
    'dashboard.alerts': '{{count}} تنبيهات',
    'dashboard.addChild': 'إضافة طفل',
    'dashboard.viewReports': 'عرض التقارير',
    'dashboard.notifications': 'الإشعارات',
    'dashboard.settings': 'الإعدادات',
    'dashboard.online': 'متصل',
    'dashboard.offline': 'غير متصل',
    'pairing.addChildTitle': 'إضافة طفل',
    'pairing.noChildrenYet': 'أضف طفلًا من لوحة التحكم أولًا قبل إقران جهاز.',
    'pairing.selectChild': 'اختر الطفل',
    'pairing.generateCode': 'إنشاء رمز إقران',
    'pairing.validFor': 'صالح لمدة',
    'notifications.title': 'الإشعارات',
    'notifications.empty': 'لا يوجد إشعارات بعد.',
    'notifications.markAllRead': 'تعليم الكل كمقروء',
    'settings.title': 'الإعدادات',
    'settings.language': 'اللغة',
    'settings.profile': 'الملف الشخصي',
    'settings.subscription': 'الاشتراك',
    'settings.privacy': 'الخصوصية',
    'settings.logout': 'تسجيل الخروج',
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

/// Same fallback strategy as the Dashboard's `translate()`: requested
/// locale -> default locale -> the raw key itself (never blank).
String translate(AppLocale locale, String key, {int? count, Map<String, Object>? options}) {
  final resources = _resources[locale] ?? _resources[defaultLocale]!;
  final resolvedKey = _resolvePluralKey(key, count, resources);

  final template = resources[resolvedKey] ?? _resources[defaultLocale]![resolvedKey] ?? key;

  final interpolationOptions = <String, Object>{if (count != null) 'count': count, ...?options};
  return _interpolate(template, interpolationOptions);
}
