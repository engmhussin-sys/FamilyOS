// EVERY SUBSCRIPTION STATE A HOUSEHOLD CAN BE IN HAS A SENTENCE.
//
// EXECUTION STATUS: NEVER RUN. There is no Flutter or Dart SDK reachable from
// the environment this was authored in (the SDK hosts answer 403 to CONNECT),
// so `flutter test` was never invoked. STATIC VERIFIED ONLY by
// `scripts/dart_preflight.py`, which checks arity, named parameters, member
// references and import scope and executes nothing. First execution is on a
// GitHub runner.
//
// Pure Dart over the localization engine — no widgets, no mocked billing API.
// `_StatusBanner` branches on a BACKEND value (`subscription.status`) and is
// private, so what is testable and what is actually worth testing are the
// same thing: that the eight values `SubscriptionStatus` can hold each have a
// title and a body, and that the ones which mean opposite things do not say
// the same thing.
//
// WHAT HAD SHIPPED: the banner was written against the five statuses that
// existed in Sprint 8. PHASE D added PENDING, GRACE_PERIOD and REFUNDED, and
// all three fell through to «ابدأ الآن — اختر خطة للبدء.». GRACE_PERIOD is
// entitlement-bearing (`entitlement.service.ts` lists it beside TRIALING and
// ACTIVE), so a household with full paid access was told it had none and
// invited to buy what it already had.

import 'package:flutter_test/flutter_test.dart';

import 'package:parent_app/core/localization/localization_engine.dart';

void main() {
  // `SubscriptionStatus` in apps/backend/prisma/schema.prisma, mapped to the
  // title key `_StatusBanner` renders for it. Restated here because this app
  // cannot import Prisma; a ninth status added upstream is meant to fail this
  // list rather than quietly reach the `else` branch.
  const titleForStatus = <String, String>{
    'TRIALING': 'subscription.inactiveTitle',
    'ACTIVE': 'subscription.activeTitle',
    'PAST_DUE': 'subscription.pastDueTitle',
    'CANCELED': 'subscription.inactiveTitle',
    'EXPIRED': 'subscription.inactiveTitle',
    'PENDING': 'subscription.pendingTitle',
    'GRACE_PERIOD': 'subscription.graceTitle',
    'REFUNDED': 'subscription.refundedTitle',
  };

  const bodyForStatus = <String, String>{
    'PAST_DUE': 'subscription.pastDueBody',
    'CANCELED': 'subscription.inactiveBody',
    'PENDING': 'subscription.pendingBody',
    'GRACE_PERIOD': 'subscription.graceBody',
    'REFUNDED': 'subscription.refundedBody',
  };

  group('every status has somewhere to land, in both locales', () {
    test('all eight titles resolve', () {
      expect(titleForStatus.length, 8);
      for (final entry in titleForStatus.entries) {
        for (final locale in AppLocale.values) {
          expect(
            hasTranslation(locale, entry.value),
            isTrue,
            reason: '${entry.key} has no $locale title, so it would fall '
                'through to "you have no subscription".',
          );
        }
      }
    });

    test('all the bodies resolve, and none is the key showing through', () {
      for (final entry in bodyForStatus.entries) {
        for (final locale in AppLocale.values) {
          expect(hasTranslation(locale, entry.value), isTrue,
              reason: '${entry.key} has no $locale body.');
          expect(translate(locale, entry.value), isNot(contains('subscription.')));
        }
      }
    });
  });

  group('the states that mean opposite things do not say the same thing', () {
    test('GRACE_PERIOD never tells an entitled household it has no '
        'subscription', () {
      // The one that actually mattered. `entitlement.service.ts` grants full
      // access in GRACE_PERIOD, so «اختر خطة للبدء» is not vague here, it is
      // false.
      for (final locale in AppLocale.values) {
        final grace = translate(locale, 'subscription.graceBody');
        expect(grace, isNot(equals(translate(locale, 'subscription.noneBody'))));
        expect(grace, isNot(equals(translate(locale, 'subscription.inactiveBody'))));
      }
    });

    test('GRACE_PERIOD does not quote a window length the client cannot know', () {
      // The grace window is server-configured (Q17). A number hardcoded in
      // app copy becomes wrong the moment that config changes, and it is the
      // sort of promise a parent plans around.
      final ar = translate(AppLocale.ar, 'subscription.graceBody');
      final en = translate(AppLocale.en, 'subscription.graceBody');
      expect(RegExp(r'\d').hasMatch(ar), isFalse);
      expect(RegExp(r'\d').hasMatch(en), isFalse);
    });

    test('PENDING is distinct from both active and absent', () {
      for (final locale in AppLocale.values) {
        final pending = translate(locale, 'subscription.pendingBody');
        expect(pending, isNot(equals(translate(locale, 'subscription.noneBody'))));
        expect(pending, isNot(equals(translate(locale, 'subscription.activeBodyNoPlan'))));
      }
    });

    test('REFUNDED is distinct from CANCELED, because entitlement ended at a '
        'different moment', () {
      for (final locale in AppLocale.values) {
        expect(
          translate(locale, 'subscription.refundedBody'),
          isNot(equals(translate(locale, 'subscription.inactiveBody'))),
        );
      }
    });

    test('no status body is empty', () {
      for (final key in bodyForStatus.values) {
        for (final locale in AppLocale.values) {
          expect(translate(locale, key).trim(), isNotEmpty);
        }
      }
    });
  });
}
