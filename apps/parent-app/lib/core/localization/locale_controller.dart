import 'dart:ui' show PlatformDispatcher;

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'localization_engine.dart';

/// Where the chosen language is persisted.
///
/// Kept behind an interface for one concrete reason: `SharedPreferences`
/// needs a platform channel, so a widget test that merely builds a screen
/// would otherwise have to set up a mock channel just to read a language.
/// Tests can pass [InMemoryLocaleStorage] instead.
abstract class LocaleStorage {
  Future<AppLocale?> read();

  Future<void> write(AppLocale locale);
}

/// SharedPreferences, deliberately NOT `flutter_secure_storage`.
///
/// The selected language is not a secret, and the secure store used
/// elsewhere in this app is Keystore-backed and comparatively slow — it is
/// reserved for the device-bound refresh token (Decision-012). Putting a
/// UI preference there would be a category error.
class SharedPreferencesLocaleStorage implements LocaleStorage {
  const SharedPreferencesLocaleStorage();

  static const String storageKey = 'abny.locale';

  @override
  Future<AppLocale?> read() async {
    final prefs = await SharedPreferences.getInstance();
    return appLocaleFromCode(prefs.getString(storageKey));
  }

  @override
  Future<void> write(AppLocale locale) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(storageKey, appLocaleCode(locale));
  }
}

/// Test double — no platform channel, no async I/O of consequence.
class InMemoryLocaleStorage implements LocaleStorage {
  InMemoryLocaleStorage([this._value]);

  AppLocale? _value;

  @override
  Future<AppLocale?> read() async => _value;

  @override
  Future<void> write(AppLocale locale) async => _value = locale;
}

/// Mirrors apps/admin-dashboard/src/shared/i18n/LocaleProvider.tsx's
/// role — the one piece of app state every screen reads locale through,
/// never `localization_engine.dart`'s functions directly.
///
/// PRODUCTION READINESS REVIEW FINDING (fixed across all 8 screens that
/// use this): `ref.watch(localeControllerProvider.notifier)` returns a
/// STABLE object reference — Riverpod does not rebuild a widget when
/// only the `.notifier` is watched, because the notifier instance
/// itself never changes, only its `state` does. Fixed by ALSO calling
/// `ref.watch(localeControllerProvider)` (the state itself) in every
/// build method — the return value is unused, but the watch call
/// registers the correct rebuild dependency.
///
/// CLOSES audit MA-016 (language was never persisted): the constructor
/// starts an asynchronous restore, and [setLocale] writes through. The
/// constructor stays synchronous on purpose so the provider signature and
/// all existing call sites are untouched — the app renders one frame in
/// the resolved default (Arabic) and then rebuilds if a different saved
/// choice comes back, which is a single frame, not a visible flash.
class LocaleController extends StateNotifier<AppLocale> {
  LocaleController({LocaleStorage? storage})
      : _storage = storage ?? const SharedPreferencesLocaleStorage(),
        super(defaultLocale) {
    _restore();
  }

  final LocaleStorage _storage;

  /// Resolution order, most specific first:
  ///   1. what the user explicitly chose last time (persisted);
  ///   2. the device's own language, if we support it — an Egyptian phone
  ///      set to English should open in English on first run;
  ///   3. [defaultLocale] (Arabic).
  Future<void> _restore() async {
    try {
      final saved = await _storage.read();
      if (saved != null) {
        if (mounted) state = saved;
        return;
      }
      final device = appLocaleFromCode(
        PlatformDispatcher.instance.locale.languageCode,
      );
      if (device != null && mounted) state = device;
    } catch (_) {
      // Best-effort: a failed preferences read must never stop the app
      // from starting. `defaultLocale` (Arabic) already holds, which is
      // the correct answer for the primary market anyway.
    }
  }

  void setLocale(AppLocale locale) {
    state = locale;
    // Fire-and-forget: the UI must switch language immediately, not wait
    // on disk. A failed write costs the preference on next launch, which
    // is strictly better than blocking or throwing inside a setter.
    _storage.write(locale).catchError((_) {});
  }

  String t(String key, {int? count, Map<String, Object>? options}) {
    return translate(state, key, count: count, options: options);
  }

  bool get isRtl => rtlLocales.contains(state);

  /// Bridges this app's own AppLocale enum to Flutter's real `dart:ui`
  /// Locale — needed so MaterialApp.locale can drive native Material
  /// widget localization (showDatePicker, default dialog button text),
  /// which Directionality alone never covered.
  Locale get toLocale => switch (state) {
        AppLocale.en => const Locale('en'),
        AppLocale.ar => const Locale('ar'),
      };
}

final localeControllerProvider = StateNotifierProvider<LocaleController, AppLocale>(
  (ref) => LocaleController(),
);
