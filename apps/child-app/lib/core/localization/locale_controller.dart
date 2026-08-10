import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'localization_engine.dart';

/// Mirrors apps/parent-app/lib/core/localization/locale_controller.dart's
/// exact pattern — including a real bug that project's own review
/// found and fixed (watching ONLY `.notifier` doesn't trigger a
/// Riverpod rebuild when locale changes, since the notifier instance
/// itself never changes). Every screen using this MUST also call
/// `ref.watch(localeControllerProvider)` (the state itself) in its
/// build method, not just `.notifier`, to register the correct
/// rebuild dependency.
class LocaleController extends StateNotifier<AppLocale> {
  LocaleController() : super(defaultLocale);

  void setLocale(AppLocale locale) => state = locale;

  String t(String key, {int? count, Map<String, Object>? options}) {
    return translate(state, key, count: count, options: options);
  }

  bool get isRtl => rtlLocales.contains(state);

  Locale get toLocale => switch (state) {
        AppLocale.en => const Locale('en'),
        AppLocale.ar => const Locale('ar'),
      };
}

final localeControllerProvider = StateNotifierProvider<LocaleController, AppLocale>(
  (ref) => LocaleController(),
);
