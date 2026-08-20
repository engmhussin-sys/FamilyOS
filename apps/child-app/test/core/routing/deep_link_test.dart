// WHERE A NOTIFICATION TAP LANDS — the child's half of `abny://`.
//
// Two layers, tested apart because they fail apart: `parseDeepLink` turns a
// string into a destination and is TOTAL, and `ChildDeepLinkRouter.resolve`
// turns a destination into a tab (plus, at most, one pushed screen) and is
// PURE. Neither needs a widget, a navigator or a network, so neither is tested
// through one.
//
// THE FOUR CLAIMS THIS FILE MAKES:
//   1. every surface in the server's canonical list parses;
//   2. malformed input never throws — null, blank, wrong scheme, unknown
//      surface, extra segments, a hostile id, a 400-character id;
//   3. the surfaces that are meaningless for a child — approvals, approval/id,
//      subscription, child/id, safety/id — resolve to the child's own home and
//      never to a parent concept or a blank screen;
//   4. the id-bearing and the id-less form of the same surface both resolve.
//
// EXECUTION STATUS: NEVER RUN. There is no Flutter SDK and no Dart SDK in the
// authoring environment, and pub.dev is unreachable, so these tests have never
// been executed. They are STATIC VERIFIED by `scripts/dart_preflight.py`,
// `scripts/verify_dart_imports.py` and `scripts/verify_l10n_parity.py` only.

import 'package:flutter_test/flutter_test.dart';

import 'package:child_app/core/routing/child_deep_link_router.dart';
import 'package:child_app/core/routing/child_home_tab.dart';
import 'package:child_app/core/routing/deep_link.dart';

/// A real UUID, the shape the server interpolates. Nothing here depends on the
/// format — the parser checks shape, not UUID-ness — but using the real one
/// keeps the fixtures honest about what actually arrives.
const String _id = '3f7c1b2a-9d4e-4c8b-a1f0-2e5d6c7b8a90';

/// The whole canonical surface list, wire-name for wire-name with
/// `DEEP_LINK_SURFACES` in `notification-destination.ts`. If the server adds
/// one, this list is where the child app finds out.
const List<String> _idLessWireNames = [
  'goals',
  'approvals',
  'rewards',
  'progress',
  'coach',
  'screen-time',
  'subscription',
  'notifications',
];

const List<String> _idBearingWireNames = ['goal', 'approval', 'safety', 'child'];

void main() {
  group('parseDeepLink — every canonical surface', () {
    test('every id-less surface parses to itself, id-free', () {
      const expected = <String, DeepLinkSurface>{
        'goals': DeepLinkSurface.goals,
        'approvals': DeepLinkSurface.approvals,
        'rewards': DeepLinkSurface.rewards,
        'progress': DeepLinkSurface.progress,
        'coach': DeepLinkSurface.coach,
        'screen-time': DeepLinkSurface.screenTime,
        'subscription': DeepLinkSurface.subscription,
        'notifications': DeepLinkSurface.notifications,
      };
      // The map and the list are kept in step, so a surface added to one and
      // forgotten in the other is a failure here rather than a dead tap.
      expect(expected.keys.toSet(), _idLessWireNames.toSet());

      expected.forEach((wire, surface) {
        final parsed = parseDeepLink('abny://$wire');
        expect(parsed.matches(DeepLinkDestination(surface)), isTrue,
            reason: 'abny://$wire parsed to $parsed');
        expect(parsed.uri, 'abny://$wire');
      });
    });

    test('every id-bearing surface parses with its id intact', () {
      const expected = <String, DeepLinkSurface>{
        'goal': DeepLinkSurface.goal,
        'approval': DeepLinkSurface.approval,
        'safety': DeepLinkSurface.safety,
        'child': DeepLinkSurface.child,
      };
      expect(expected.keys.toSet(), _idBearingWireNames.toSet());

      expected.forEach((wire, surface) {
        final parsed = parseDeepLink('abny://$wire/$_id');
        expect(parsed.matches(DeepLinkDestination(surface, id: _id)), isTrue,
            reason: 'abny://$wire/$_id parsed to $parsed');
        expect(parsed.uri, 'abny://$wire/$_id');
      });
    });

    test('the wire name of every surface round-trips through the enum', () {
      for (final surface in DeepLinkSurface.values) {
        final wire = deepLinkSurfaceWireName(surface);
        final link = deepLinkSurfaceTakesId(surface)
            ? 'abny://$wire/$_id'
            : 'abny://$wire';
        expect(parseDeepLink(link).surface, surface);
      }
    });
  });

  group('parseDeepLink — malformed input is a value, never an exception', () {
    // Each of these must land on the inbox, and — the point of the group —
    // none of them may throw. `parseDeepLink` runs on a path a child reached
    // by tapping something.
    const inboxCases = <String?>[
      null,
      '',
      '   ',
      '\n',
      'abny://',
      'abny:/goals',
      'abny:goals',
      'ABNY://goals',
      'abny://Goals',
      'abny://GOALS',
      'https://abny.app/goals',
      'abny://unknown-surface',
      'abny://goals/extra',
      'abny://rewards/anything',
      'abny://notifications/1',
      'abny://goals?tab=1',
      'abny://goals#top',
      'abny://goal/one/two',
      'javascript:alert(1)',
      'abny://goal/ ',
      'abny://goal/a b',
      'abny://goal/../../etc/passwd',
    ];

    for (final input in inboxCases) {
      test('«$input» degrades to the inbox without throwing', () {
        final parsed = parseDeepLink(input);
        expect(parsed.matches(DeepLinkDestination.inbox), isTrue,
            reason: '«$input» parsed to $parsed');
        expect(parsed.isInbox, isTrue);
      });
    }

    test('an over-long id is rejected rather than carried', () {
      final long = 'a' * 129;
      // A BROKEN id, not an absent one: the server would never have written
      // this, so it is the fallback rather than the goal list.
      expect(parseDeepLink('abny://goal/$long').isInbox, isTrue);
    });

    test('an id at the length boundary is accepted', () {
      final id = 'a' * 128;
      expect(parseDeepLink('abny://goal/$id').id, id);
    });

    test('surrounding whitespace is trimmed, not rejected', () {
      expect(
        parseDeepLink('  abny://rewards  ')
            .matches(const DeepLinkDestination(DeepLinkSurface.rewards)),
        isTrue,
      );
    });
  });

  group('parseDeepLink — id-less and id-bearing forms both resolve', () {
    // The backend emits the id-less form on every producer path today (no
    // producer carries a row id to the destination layer yet), so this is the
    // shape that actually arrives.
    test('a bare id-bearing surface takes the server\'s own list form', () {
      expect(
        parseDeepLink('abny://goal')
            .matches(const DeepLinkDestination(DeepLinkSurface.goals)),
        isTrue,
      );
      expect(
        parseDeepLink('abny://approval')
            .matches(const DeepLinkDestination(DeepLinkSurface.approvals)),
        isTrue,
      );
      expect(
        parseDeepLink('abny://safety')
            .matches(const DeepLinkDestination(DeepLinkSurface.screenTime)),
        isTrue,
      );
      // `child` has no list form in a single-child app — the fallback is the
      // only honest answer.
      expect(parseDeepLink('abny://child').isInbox, isTrue);
    });

    test('the parser never returns an id-bearing surface without an id', () {
      for (final wire in _idBearingWireNames) {
        final parsed = parseDeepLink('abny://$wire');
        expect(deepLinkSurfaceTakesId(parsed.surface) && parsed.id == null,
            isFalse,
            reason: 'abny://$wire parsed to $parsed');
      }
    });
  });

  group('deepLinkFromNotification — both payload shapes, one parser', () {
    test('reads a nested `data.deepLink` (an inbox row)', () {
      expect(
        deepLinkFromNotification(<String, dynamic>{
          'id': 'msg_1',
          'title': 'x',
          'data': <String, dynamic>{'deepLink': 'abny://rewards'},
        }),
        'abny://rewards',
      );
    });

    test('reads a top-level `deepLink` (a raw FCM data map)', () {
      expect(
        deepLinkFromNotification(<String, dynamic>{'deepLink': 'abny://coach'}),
        'abny://coach',
      );
    });

    test('absence, wrong types and non-maps are null, never a throw', () {
      expect(deepLinkFromNotification(null), isNull);
      expect(deepLinkFromNotification('abny://goals'), isNull);
      expect(deepLinkFromNotification(<String, dynamic>{}), isNull);
      expect(
        deepLinkFromNotification(<String, dynamic>{'deepLink': 42}),
        isNull,
      );
      expect(
        deepLinkFromNotification(<String, dynamic>{'data': 'not-a-map'}),
        isNull,
      );
      // Null in, inbox out — a caller never has to branch on absence.
      expect(parseDeepLink(deepLinkFromNotification(null)).isInbox, isTrue);
    });
  });

  group('ChildDeepLinkRouter.resolve — the child\'s own screens', () {
    test('the four tabs are reached as TABS, not as pushed screens', () {
      const cases = <String, ChildHomeTab>{
        'abny://goals': ChildHomeTab.today,
        'abny://rewards': ChildHomeTab.rewards,
        'abny://progress': ChildHomeTab.progress,
        'abny://coach': ChildHomeTab.coach,
      };
      cases.forEach((link, tab) {
        final route = ChildDeepLinkRouter.resolveLink(link);
        expect(route.matches(ChildDeepLinkRoute(tab)), isTrue,
            reason: '$link resolved to $route');
        expect(route.screen, ChildDeepLinkScreen.none);
      });
    });

    test('a goal link carries its id and still lands on the goal list tab', () {
      final route = ChildDeepLinkRouter.resolveLink('abny://goal/$_id');
      expect(
        route.matches(const ChildDeepLinkRoute(ChildHomeTab.today, goalId: _id)),
        isTrue,
      );
    });

    test('the id-less goal link lands on the same tab, without an id', () {
      final route = ChildDeepLinkRouter.resolveLink('abny://goal');
      expect(route.matches(const ChildDeepLinkRoute(ChildHomeTab.today)), isTrue);
      expect(route.goalId, isNull);
    });

    test('screen-time and the inbox both open «نموّي»', () {
      for (final link in ['abny://screen-time', 'abny://notifications']) {
        final route = ChildDeepLinkRouter.resolveLink(link);
        expect(
          route.matches(const ChildDeepLinkRoute(
            ChildHomeTab.today,
            screen: ChildDeepLinkScreen.myGrowth,
          )),
          isTrue,
          reason: '$link resolved to $route',
        );
      }
    });

    test('every surface resolves — resolve is total over the enum', () {
      for (final surface in DeepLinkSurface.values) {
        final destination = deepLinkSurfaceTakesId(surface)
            ? DeepLinkDestination(surface, id: _id)
            : DeepLinkDestination(surface);
        // No throw, and a tab is always named: the shell is always underneath.
        final route = ChildDeepLinkRouter.resolve(destination);
        expect(ChildHomeTab.values.contains(route.tab), isTrue);
      }
    });
  });

  group('ChildDeepLinkRouter — a child never lands on a parent concept', () {
    // The server already refuses to send a child-audience notification to a
    // parent-only surface. This asserts what happens if one arrives anyway:
    // the child's own home, never an approval queue, never a billing screen,
    // never a safety alert about themselves, never a blank screen.
    const parentOnly = <String>[
      'abny://approvals',
      'abny://approval',
      'abny://subscription',
      'abny://child',
    ];

    for (final link in parentOnly) {
      test('«$link» lands on the child\'s home tab', () {
        final route = ChildDeepLinkRouter.resolveLink(link);
        expect(route.tab, ChildHomeTab.today);
      });
    }

    test('an id-bearing approval, child and safety link land at home too', () {
      for (final wire in ['approval', 'child', 'safety']) {
        final route = ChildDeepLinkRouter.resolveLink('abny://$wire/$_id');
        expect(route.tab, ChildHomeTab.today,
            reason: 'abny://$wire/$_id resolved to $route');
        expect(route.goalId, isNull);
      }
    });

    test('a safety alert never opens a screen of its own', () {
      final route = ChildDeepLinkRouter.resolveLink('abny://safety/$_id');
      expect(route.screen, ChildDeepLinkScreen.none);
    });
  });

  group('childHomeTabFromIndex — a bad index is not a crash in a child\'s hand',
      () {
    test('valid indices map to the bar\'s own order', () {
      expect(childHomeTabFromIndex(0), ChildHomeTab.today);
      expect(childHomeTabFromIndex(1), ChildHomeTab.rewards);
      expect(childHomeTabFromIndex(2), ChildHomeTab.progress);
      expect(childHomeTabFromIndex(3), ChildHomeTab.coach);
    });

    test('out-of-range degrades to today rather than throwing', () {
      expect(childHomeTabFromIndex(-1), ChildHomeTab.today);
      expect(childHomeTabFromIndex(99), ChildHomeTab.today);
    });
  });
}
