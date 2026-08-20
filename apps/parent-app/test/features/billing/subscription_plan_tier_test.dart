// THE PLAN TIER, AS A PARENT READS IT.
//
// EXECUTION STATUS: NEVER RUN. There is no Flutter or Dart SDK reachable from
// the environment this was authored in (the SDK hosts answer 403 to CONNECT),
// so `flutter test` was never invoked. STATIC VERIFIED ONLY by
// `scripts/dart_preflight.py`, which checks arity, named parameters, member
// references and import scope and executes nothing. First execution is on a
// GitHub runner.
//
// Pure Dart over the localization engine — no widgets, no pumping, no mocked
// billing API. That is deliberate: the bug pinned here is not in the widget
// tree, it is in the vocabulary. `SubscriptionScreen` builds a key out of a
// BACKEND value (`planTier`), and `translate` answers a missing key with the
// key itself, so the property worth pinning is "every value the backend can
// send has somewhere to land" — which is exactly a table check.
//
// WHAT HAD SHIPPED: `subscription.activeBody` interpolated `planTier`
// straight from the wire, so a paying Arabic-locale parent read «أنت مشترك في
// خطة PREMIUM» — a Latin-letter database enum in the middle of an Arabic
// sentence, on the one screen that handles money.

import 'package:flutter_test/flutter_test.dart';

import 'package:parent_app/core/localization/localization_engine.dart';

void main() {
  // `SubscriptionPlanTier` in apps/backend/src/modules/billing/domain/
  // billing.types.ts. Restated here because this app cannot import
  // TypeScript; if the backend adds a sixth tier, this list and the engine
  // both need it, and this test is where that is noticed.
  const planTiers = <String>['FREE', 'BASIC', 'PREMIUM', 'FAMILY', 'ENTERPRISE'];

  group('a plan tier never reaches a parent as a raw enum', () {
    test('every tier the backend can send has a label in BOTH locales', () {
      for (final tier in planTiers) {
        for (final locale in AppLocale.values) {
          expect(
            hasTranslation(locale, 'planTier.$tier'),
            isTrue,
            reason: 'planTier.$tier has no $locale label, so SubscriptionScreen '
                'would stop naming the tier at all.',
          );
        }
      }
    });

    test('no label is just the enum value wearing a translation', () {
      for (final tier in planTiers) {
        final ar = translate(AppLocale.ar, 'planTier.$tier');
        expect(ar, isNot(contains(tier)));
        expect(ar, isNot(contains('planTier.')));
      }
    });

    test('an unknown tier is NOT claimed to have a label, so the screen can '
        'choose a sentence that names no tier', () {
      // The guard `SubscriptionScreen._planLabel` relies on. If this ever
      // answered true, `translate` would hand back the key itself and a
      // parent would read «خطة planTier.WHATEVER» — the same bug wearing a
      // prefix.
      expect(hasTranslation(AppLocale.ar, 'planTier.WHATEVER'), isFalse);
      expect(translate(AppLocale.ar, 'planTier.WHATEVER'), 'planTier.WHATEVER');
    });

    test('the tier-free sentence exists, because that is what an unrecognised '
        'tier falls back to', () {
      for (final locale in AppLocale.values) {
        expect(hasTranslation(locale, 'subscription.activeBodyNoPlan'), isTrue);
      }
      // It must not carry the {plan} placeholder — the whole point of this
      // sentence is that it names no tier, so an unsubstituted placeholder
      // would be visible on screen.
      expect(translate(AppLocale.ar, 'subscription.activeBodyNoPlan'), isNot(contains('{plan}')));
      expect(translate(AppLocale.en, 'subscription.activeBodyNoPlan'), isNot(contains('{plan}')));
    });

    test('the sentence that DOES name a tier still substitutes it', () {
      // Guards the interpolation itself: if `{plan}` were renamed on one side
      // only, the placeholder would render literally to a parent.
      final ar = translate(AppLocale.ar, 'subscription.activeBody',
          options: {'plan': translate(AppLocale.ar, 'planTier.PREMIUM')});

      expect(ar, contains(translate(AppLocale.ar, 'planTier.PREMIUM')));
      expect(ar, isNot(contains('{plan}')));
      expect(ar, isNot(contains('PREMIUM')));
    });
  });
}
