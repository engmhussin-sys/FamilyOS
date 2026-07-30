import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'localization_engine.dart';

/// Mirrors apps/admin-dashboard/src/shared/i18n/LocaleProvider.tsx's
/// role — the one piece of app state every screen reads locale through,
/// never `localization_engine.dart`'s functions directly.
class LocaleController extends StateNotifier<AppLocale> {
  LocaleController() : super(defaultLocale);

  void setLocale(AppLocale locale) => state = locale;

  String t(String key, {int? count, Map<String, Object>? options}) {
    return translate(state, key, count: count, options: options);
  }

  bool get isRtl => rtlLocales.contains(state);
}

final localeControllerProvider = StateNotifierProvider<LocaleController, AppLocale>(
  (ref) => LocaleController(),
);
