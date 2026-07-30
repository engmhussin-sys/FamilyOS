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
