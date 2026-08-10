import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'localization_engine.dart';

/// Mirrors apps/admin-dashboard/src/shared/i18n/LocaleProvider.tsx's
/// role — the one piece of app state every screen reads locale through,
/// never `localization_engine.dart`'s functions directly.
///
/// PRODUCTION READINESS REVIEW FINDING (fixed across all 8 screens that
/// use this): `ref.watch(localeControllerProvider.notifier)` returns a
/// STABLE object reference — Riverpod does not rebuild a widget when
/// only the `.notifier` is watched, because the notifier instance
/// itself never changes, only its `state` does. Every screen was
/// calling `ref.watch(localeControllerProvider.notifier).t` to get the
/// translate function, which silently meant: changing the language in
/// Settings would NOT cause an already-built screen to re-render with
/// the new language until it was rebuilt for some unrelated reason
/// (e.g. navigating away and back). Fixed by ALSO calling
/// `ref.watch(localeControllerProvider)` (the state itself) in every
/// build method — the return value is unused, but the watch call
/// registers the correct rebuild dependency. This is the standard
/// Riverpod pattern for "read the state to get properly notified, read
/// the notifier to call its methods."
class LocaleController extends StateNotifier<AppLocale> {
  LocaleController() : super(defaultLocale);

  void setLocale(AppLocale locale) => state = locale;

  String t(String key, {int? count, Map<String, Object>? options}) {
    return translate(state, key, count: count, options: options);
  }

  bool get isRtl => rtlLocales.contains(state);

  /// CLOSES A REAL GAP (Master Completeness Audit): bridges this
  /// app's own AppLocale enum to Flutter's real `dart:ui` Locale —
  /// needed so MaterialApp.locale can drive native Material widget
  /// localization (showDatePicker, default dialog button text),
  /// which Directionality alone (main.dart) never covered.
  Locale get toLocale => switch (state) {
        AppLocale.en => const Locale('en'),
        AppLocale.ar => const Locale('ar'),
      };
}

final localeControllerProvider = StateNotifierProvider<LocaleController, AppLocale>(
  (ref) => LocaleController(),
);
