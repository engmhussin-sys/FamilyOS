// WHAT THIS FILE PROVES — every destination the scheme can express resolves to
// something this app can actually do, and the map says out loud which surfaces
// have no screen rather than pretending they do.
//
// `DeepLinkRouter.resolve` is a pure function precisely so this file exists: the
// whole notification→screen map is assertable without pumping a widget, without
// a Navigator and without a fake repository. The widget-level half — that a tap
// really marks the row read and really pushes — lives in
// `test/features/notifications/notification_tap_test.dart`.
//
// THE ONE THING THIS FILE IS CAREFUL ABOUT: it asserts the ROUTE NAME, not the
// screen class, for named routes. `main.dart` owns the name→screen table; a test
// that reached past the name into the widget would be testing `main.dart` from
// here and would pass while `main.dart` had removed the registration.
// `test/core/routing/app_routes_registration_test.dart` is the file that would
// close that last gap and it is NOT written — named in the report, not silently
// assumed.
//
// EXECUTION STATUS: NEVER RUN. No Flutter SDK, no Dart SDK and no pub.dev are
// reachable from the environment this was authored in. STATIC VERIFIED by
// `scripts/dart_preflight.py` only — that script checks constructor arity,
// named parameters, member references and import scope, is not a Dart analyser,
// and executes nothing. First execution happens on a CI runner.

import 'package:flutter_test/flutter_test.dart';

import 'package:parent_app/core/routing/app_routes.dart';
import 'package:parent_app/core/routing/deep_link.dart';
import 'package:parent_app/core/routing/deep_link_router.dart';

const String _uuid = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

void main() {
  group('DeepLinkRouter.resolve — the argument-free surfaces are NAMED routes', () {
    test('goals lands on the program list', () {
      final route = DeepLinkRouter.resolveLink('abny://goals');
      expect(route.kind, DeepLinkRouteKind.named);
      expect(route.routeName, AppRoutes.goals);
    });

    test('approvals lands on the achievement review queue, not the message queue', () {
      final route = DeepLinkRouter.resolveLink('abny://approvals');
      expect(route.kind, DeepLinkRouteKind.named);
      expect(route.routeName, AppRoutes.goalReviewQueue);
    });

    test('rewards lands on the fulfilment queue — the parent half of a reward', () {
      final route = DeepLinkRouter.resolveLink('abny://rewards');
      expect(route.kind, DeepLinkRouteKind.named);
      expect(route.routeName, AppRoutes.fulfilments);
    });

    test('subscription lands on the subscription screen', () {
      final route = DeepLinkRouter.resolveLink('abny://subscription');
      expect(route.kind, DeepLinkRouteKind.named);
      expect(route.routeName, AppRoutes.subscription);
    });

    test('notifications lands on the inbox', () {
      final route = DeepLinkRouter.resolveLink('abny://notifications');
      expect(route.kind, DeepLinkRouteKind.named);
      expect(route.routeName, AppRoutes.notifications);
    });

    test('screen-time lands on the safety surface — the SERVER calls it that', () {
      // NOT a reinterpretation by this client. `safetyDestination` in
      // `notification-destination.ts` is literally
      // `idLink('safety', alertId, surfaceLink('screen-time'))`, so the server
      // itself defines `abny://screen-time` as the ID-LESS FORM OF `safety` —
      // and since no producer carries an `alertId` today, it is the ONLY form
      // any of the four device alerts is ever emitted as.
      final route = DeepLinkRouter.resolveLink('abny://screen-time');
      expect(route.kind, DeepLinkRouteKind.named);
      expect(route.routeName, AppRoutes.safety);
    });

    test('a bare safety destination lands on the same surface, not the inbox', () {
      // Unreachable through `parseDeepLink`; reachable by a caller building a
      // destination by hand. A destination that names no alert still names the
      // surface, and the surface now exists.
      const handBuilt = DeepLinkDestination(DeepLinkSurface.safety);
      final route = DeepLinkRouter.resolve(handBuilt);
      expect(route.kind, DeepLinkRouteKind.named);
      expect(route.routeName, AppRoutes.safety);
    });
  });

  group('DeepLinkRouter.resolve — the id-scoped surfaces are PAGES, never names', () {
    test('one goal is a constructed page, not a name with an untyped argument', () {
      final route = DeepLinkRouter.resolveLink('abny://goal/$_uuid');
      expect(route.kind, DeepLinkRouteKind.page);
      expect(route.pageBuilder, isNotNull);
      // The distinction `app_routes.dart` documents: an id-scoped screen never
      // acquires a route name, because a name would mean smuggling the id
      // through `settings.arguments` as an untyped Object.
      expect(route.routeName, isNull);
    });

    test('one approval is a constructed page', () {
      final route = DeepLinkRouter.resolveLink('abny://approval/$_uuid');
      expect(route.kind, DeepLinkRouteKind.page);
      expect(route.pageBuilder, isNotNull);
      expect(route.routeName, isNull);
    });

    test('an id-bearing destination built without an id is unopenable, not a crash', () {
      // Unreachable through `parseDeepLink` (a bare `abny://goal` is already the
      // inbox there); reachable by a caller constructing one by hand.
      const handBuilt = DeepLinkDestination(DeepLinkSurface.goal);
      expect(DeepLinkRouter.resolve(handBuilt).kind, DeepLinkRouteKind.unavailable);
    });

    test('one safety alert is a constructed page carrying the alert id', () {
      final route = DeepLinkRouter.resolveLink('abny://safety/$_uuid');
      expect(route.kind, DeepLinkRouteKind.page);
      expect(route.pageBuilder, isNotNull);
      expect(route.routeName, isNull);
    });

    test('one child is a constructed page, not a name with an untyped argument', () {
      final route = DeepLinkRouter.resolveLink('abny://child/$_uuid');
      expect(route.kind, DeepLinkRouteKind.page);
      expect(route.pageBuilder, isNotNull);
      expect(route.routeName, isNull);
    });

    test('a child destination built without an id names nobody, and says so', () {
      // `ChildDetailScreen` cannot be constructed without a childId, and there
      // is no «the child list» to degrade to that is not simply the dashboard.
      const handBuilt = DeepLinkDestination(DeepLinkSurface.child);
      expect(DeepLinkRouter.resolve(handBuilt).kind, DeepLinkRouteKind.unavailable);
    });
  });

  group('DeepLinkRouter.resolve — the surfaces with no screen say so', () {
    // TWO REMAIN, not five. `safety`, `child` and `screen-time` are now open.
    //
    // `progress` and `coach` stay unavailable for a reason that is a PRODUCT
    // decision rather than a missing screen: their screens exist and both need
    // `childId` AND `childName`, which no `abny://` link carries — the server
    // pins `notifications.data` identifier-free on purpose. `ChildDetailScreen`
    // is now the natural HOST for both, but hosting is not opening: `resolve`
    // is a pure function of the DESTINATION, and a destination with no id names
    // no child. Choosing one here would be this client deciding something the
    // server declined to say.
    const unopenable = <String>[
      'abny://progress',
      'abny://coach',
    ];

    test('each one resolves to unavailable — never a null builder, never a throw', () {
      for (final link in unopenable) {
        final route = DeepLinkRouter.resolveLink(link);
        expect(route.kind, DeepLinkRouteKind.unavailable, reason: link);
        expect(route.routeName, isNull, reason: link);
        expect(route.pageBuilder, isNull, reason: link);
      }
    });

    test('the three that used to be here are not unavailable any more', () {
      // Pinned in the POSITIVE direction as well, so a later edit that quietly
      // re-broke one of them fails here rather than on a parent's phone.
      for (final link in <String>[
        'abny://screen-time',
        'abny://safety/$_uuid',
        'abny://child/$_uuid',
      ]) {
        expect(
          DeepLinkRouter.resolveLink(link).kind,
          isNot(DeepLinkRouteKind.unavailable),
          reason: link,
        );
      }
    });
  });

  group('DeepLinkRouter.resolve — totality', () {
    test('every surface in the enum resolves, and the kinds are self-consistent', () {
      for (final surface in DeepLinkSurface.values) {
        final destination = deepLinkSurfaceTakesId(surface)
            ? DeepLinkDestination(surface, id: _uuid)
            : DeepLinkDestination(surface);
        final route = DeepLinkRouter.resolve(destination);

        if (route.kind == DeepLinkRouteKind.named) {
          expect(route.routeName, isNotNull, reason: destination.uri);
          expect(route.pageBuilder, isNull, reason: destination.uri);
        } else if (route.kind == DeepLinkRouteKind.page) {
          expect(route.pageBuilder, isNotNull, reason: destination.uri);
          expect(route.routeName, isNull, reason: destination.uri);
        } else {
          expect(route.kind, DeepLinkRouteKind.unavailable, reason: destination.uri);
          expect(route.routeName, isNull, reason: destination.uri);
          expect(route.pageBuilder, isNull, reason: destination.uri);
        }
      }
    });

    test('a malformed, unknown or null link resolves to the inbox rather than throwing', () {
      const rubbish = <String?>[
        null,
        '',
        'abny://unknown-surface',
        'https://evil.example/steal',
        'abny://goals?token=abc',
        'abny://goal/not an id',
      ];
      for (final link in rubbish) {
        final route = DeepLinkRouter.resolveLink(link);
        expect(route.kind, DeepLinkRouteKind.named, reason: '$link');
        expect(route.routeName, AppRoutes.notifications, reason: '$link');
      }
    });

    test('the fallback message is a translation key, not a sentence', () {
      expect(DeepLinkRouter.unavailableMessageKey, 'deepLink.unavailable');
    });
  });
}
