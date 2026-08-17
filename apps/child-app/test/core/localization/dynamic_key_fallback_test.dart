// A CHILD MUST NEVER READ A BACKEND STATUS CODE.
//
// Two call sites in this app build a translation key out of an OPEN server
// string: `t('attemptStage.${attempt.status}')` and
// `t('category.${goal.category}')`. `status` is a plain `VarChar(20)` on the
// backend and `category` grows with the catalogue, so an unmapped value used
// to fall through `translate`'s last resort — THE KEY ITSELF — and render
// «attemptStage.CANCELLED», or, for a row with no status at all,
// «attemptStage.» to a nine-year-old.
//
// `LocaleController.tOrElse` is the guard, and this file is the proof that it
// guards the right things and does NOT silence the parity checker's own class
// of bug (a missing key for app chrome must still be loud).
//
// EXECUTION STATUS: NEVER RUN. There is no Flutter SDK and no Dart SDK in the
// authoring environment, and pub.dev is unreachable, so these tests have never
// been executed. They are STATIC VERIFIED by `scripts/dart_preflight.py`,
// `scripts/verify_dart_imports.py` and `scripts/verify_l10n_parity.py` only.

import 'package:flutter_test/flutter_test.dart';

import 'package:child_app/core/localization/locale_controller.dart';
import 'package:child_app/core/localization/localization_engine.dart';

LocaleController _controller(AppLocale locale) =>
    LocaleController(storage: InMemoryLocaleStorage(locale));

void main() {
  group('hasTranslation', () {
    test('is true for a key both locales declare', () {
      expect(hasTranslation(AppLocale.ar, 'attemptStage.VERIFIED'), isTrue);
      expect(hasTranslation(AppLocale.en, 'attemptStage.VERIFIED'), isTrue);
    });

    test('is false for a status this app has never been taught', () {
      expect(hasTranslation(AppLocale.ar, 'attemptStage.CANCELLED'), isFalse);
      expect(hasTranslation(AppLocale.ar, 'attemptStage.'), isFalse);
      expect(hasTranslation(AppLocale.ar, 'category.CHESS'), isFalse);
    });
  });

  group('tOrElse — the fallback a child actually reads', () {
    test('a known status still renders its own warm sentence', () {
      final controller = _controller(AppLocale.ar);
      expect(
        controller.tOrElse('attemptStage.PENDING_PARENT', 'FALLBACK'),
        translate(AppLocale.ar, 'attemptStage.PENDING_PARENT'),
      );
    });

    test('an unknown status renders the fallback, never the key', () {
      final controller = _controller(AppLocale.ar);
      final label = controller.tOrElse(
        'attemptStage.CANCELLED',
        translate(AppLocale.ar, 'attemptStage.unknown'),
      );

      expect(label, translate(AppLocale.ar, 'attemptStage.unknown'));
      expect(label.contains('attemptStage'), isFalse);
      expect(label.contains('CANCELLED'), isFalse);
    });

    test('an empty status — a row missing the field — is not a bare dot', () {
      final controller = _controller(AppLocale.ar);
      final label = controller.tOrElse(
        'attemptStage.',
        translate(AppLocale.ar, 'attemptStage.unknown'),
      );

      expect(label, translate(AppLocale.ar, 'attemptStage.unknown'));
    });

    test('an unknown category renders a word, not a code', () {
      for (final locale in AppLocale.values) {
        final controller = _controller(locale);
        final label = controller.tOrElse(
          'category.CHESS',
          translate(locale, 'category.unknown'),
        );

        expect(label, translate(locale, 'category.unknown'));
        expect(label.contains('CHESS'), isFalse);
      }
    });

    test('the fallback keys themselves exist in BOTH locales', () {
      // The parity checker asserts this for the whole file; this asserts it
      // for the two keys a child sees only when something has gone wrong,
      // which are exactly the two nobody would notice missing.
      for (final key in ['attemptStage.unknown', 'category.unknown']) {
        for (final locale in AppLocale.values) {
          expect(hasTranslation(locale, key), isTrue, reason: '$key in $locale');
          expect(translate(locale, key), isNot(key));
        }
      }
    });
  });

  group('translate — still loud about MISSING APP CHROME', () {
    test('an ordinary missing key still surfaces as itself', () {
      // Deliberate: silencing every missing key would hide the class of bug
      // `verify_l10n_parity.py` exists to catch. Only runtime-assembled keys
      // get a fallback, and only because the caller passes one.
      expect(translate(AppLocale.ar, 'today.thisKeyDoesNotExist'),
          'today.thisKeyDoesNotExist');
    });
  });
}
