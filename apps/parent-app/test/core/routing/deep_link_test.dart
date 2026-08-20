// WHAT THIS FILE PROVES — the string the server put on `data.deepLink` becomes
// a destination, and NO string can make the parser throw.
//
// The defect it locks down: a notification tap was a no-op. The server has
// resolved a destination for every notification since `F6-007`
// (`apps/backend/src/modules/notifications/domain/engine/notification-destination.ts`),
// and no client read it. The first half of reading it is parsing it, and a
// parser on a tap path has exactly one unacceptable behaviour: throwing.
//
// The four properties asserted here are the four ways the parser can be wrong:
//   1. a surface in the scheme does not parse (a dead tap for a whole class of
//      notification);
//   2. rubbish parses to something (a tap that lands on the wrong screen is
//      worse than one that lands on the inbox);
//   3. the id-bearing and id-less forms of the same idea disagree — the server
//      emits BOTH (`abny://goals` today, `abny://goal/<id>` the day a producer
//      carries one) and both must work;
//   4. it throws. Anything reaching this parser came off a network payload, and
//      an exception here turns a routing gap into a crash on a user's tap.
//
// EXECUTION STATUS: NEVER RUN. There is no Flutter SDK, no Dart SDK and no
// pub.dev reachable from the environment this was authored in. STATIC VERIFIED
// by `scripts/dart_preflight.py` only — constructor arity, named parameters,
// member references and import scope — which is not a Dart analyser and
// executes nothing. First execution happens on a CI runner.

import 'package:flutter_test/flutter_test.dart';

import 'package:parent_app/core/routing/deep_link.dart';

/// A UUID of the shape the server actually interpolates. Nothing here depends
/// on it BEING a UUID — ids are opaque to the client — but a test that used
/// `'x'` everywhere would not notice a parser that silently truncated.
const String _uuid = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

/// The canonical link for [surface], in whichever of the two forms that surface
/// takes. Built from the enum rather than from a hand-written list of twelve
/// strings, so a surface added tomorrow is covered by these tests today.
String _canonicalLinkFor(DeepLinkSurface surface) {
  final wire = deepLinkSurfaceWireName(surface);
  return deepLinkSurfaceTakesId(surface) ? 'abny://$wire/$_uuid' : 'abny://$wire';
}

void main() {
  group('parseDeepLink — every surface in the scheme', () {
    test('each of the twelve surfaces parses to itself and round-trips', () {
      for (final surface in DeepLinkSurface.values) {
        final link = _canonicalLinkFor(surface);
        final parsed = parseDeepLink(link);

        expect(parsed.surface, surface, reason: link);
        expect(
          parsed.id,
          deepLinkSurfaceTakesId(surface) ? _uuid : isNull,
          reason: link,
        );
        // `uri` rebuilds the canonical form from the parsed value: if these
        // agree, the parser lost nothing and invented nothing.
        expect(parsed.uri, link, reason: link);
      }
    });

    test('the wire names are exactly the twelve the server publishes', () {
      final wireNames = DeepLinkSurface.values.map(deepLinkSurfaceWireName).toList();
      expect(
        wireNames,
        containsAll(<String>[
          'goals',
          'goal',
          'approvals',
          'approval',
          'rewards',
          'progress',
          'coach',
          'screen-time',
          'safety',
          'child',
          'subscription',
          'notifications',
        ]),
      );
      expect(wireNames.length, 12);
      // No duplicates — two surfaces sharing a wire name would make one of
      // them unreachable, silently.
      expect(wireNames.toSet().length, 12);
    });

    test('exactly four surfaces take an id', () {
      final idBearing =
          DeepLinkSurface.values.where(deepLinkSurfaceTakesId).map(deepLinkSurfaceWireName).toSet();
      expect(idBearing, <String>{'goal', 'approval', 'safety', 'child'});
    });
  });

  group('parseDeepLink — the id-bearing and id-less forms of the same surface', () {
    test('the goal list and one goal both resolve, and to different places', () {
      final list = parseDeepLink('abny://goals');
      final one = parseDeepLink('abny://goal/$_uuid');

      expect(list.surface, DeepLinkSurface.goals);
      expect(list.id, isNull);
      expect(one.surface, DeepLinkSurface.goal);
      expect(one.id, _uuid);
      expect(one.matches(list), isFalse);
    });

    test('the approval queue and one approval both resolve', () {
      expect(parseDeepLink('abny://approvals').surface, DeepLinkSurface.approvals);
      expect(parseDeepLink('abny://approval/$_uuid').surface, DeepLinkSurface.approval);
      expect(parseDeepLink('abny://approval/$_uuid').id, _uuid);
    });

    test('screen-time and one safety alert both resolve', () {
      expect(parseDeepLink('abny://screen-time').surface, DeepLinkSurface.screenTime);
      expect(parseDeepLink('abny://safety/$_uuid').surface, DeepLinkSurface.safety);
    });
  });

  group('parseDeepLink — everything malformed degrades to the inbox', () {
    // Each entry is a real way a link can be wrong, not a random string.
    const malformed = <String>[
      '',
      '   ',
      'abny://',
      'abny://unknown-surface',
      'abny://GOALS', // the server rejects this too; `Uri.parse` would not have
      'abny://Goals',
      'abny:/goals', // one slash
      'abny:goals',
      'https://abny.app/goals',
      'http://goals',
      'goals',
      '/goals',
      'abny://goals?token=abc', // no query string in the scheme, ever
      'abny://goals#top',
      'abny://goals/extra', // a list surface takes no segment
      'abny://goal', // id-bearing surface with no id — see the parser's header
      'abny://approval',
      'abny://safety',
      'abny://child',
      'abny://goal/', // empty segment
      'abny://goal/..', // never a path traversal
      'abny://goal/.',
      'abny://goal/a b', // whitespace is not an id
      'abny://goal/one/two', // two segments
      'abny://notifications/extra',
      'javascript:alert(1)',
      'abny://goal/%2e%2e%2f',
    ];

    test('every malformed form resolves to the inbox and none of them throws', () {
      for (final link in malformed) {
        final parsed = parseDeepLink(link);
        expect(parsed.matches(DeepLinkDestination.inbox), isTrue, reason: '"$link"');
        expect(parsed.isInbox, isTrue, reason: '"$link"');
      }
    });

    test('null is the inbox', () {
      expect(parseDeepLink(null).isInbox, isTrue);
    });

    test('an over-long id is rejected rather than carried into a URL', () {
      final long = 'a' * 200;
      expect(parseDeepLink('abny://goal/$long').isInbox, isTrue);
    });

    test('surrounding whitespace is tolerated, not treated as malformed', () {
      expect(parseDeepLink('  abny://goals  ').surface, DeepLinkSurface.goals);
    });

    test('the inbox link itself parses to the inbox', () {
      expect(parseDeepLink('abny://notifications').isInbox, isTrue);
    });
  });

  group('deepLinkFromNotification — both payload shapes', () {
    test('reads the link off an inbox row, where it sits under `data`', () {
      const row = <String, dynamic>{
        'id': 'n_1',
        'title': 'x',
        'body': 'y',
        'readAt': null,
        'data': <String, dynamic>{'deepLink': 'abny://goals'},
      };
      expect(deepLinkFromNotification(row), 'abny://goals');
      expect(parseDeepLink(deepLinkFromNotification(row)).surface, DeepLinkSurface.goals);
    });

    test('reads the link off a raw FCM data map, where it sits at the top level', () {
      const payload = <String, dynamic>{'deepLink': 'abny://subscription'};
      expect(deepLinkFromNotification(payload), 'abny://subscription');
    });

    test('a row with no data, no link, or a non-string link yields null', () {
      expect(deepLinkFromNotification(const <String, dynamic>{'id': 'n_1'}), isNull);
      expect(
        deepLinkFromNotification(const <String, dynamic>{'data': <String, dynamic>{}}),
        isNull,
      );
      expect(
        deepLinkFromNotification(const <String, dynamic>{'data': <String, dynamic>{'deepLink': 7}}),
        isNull,
      );
      expect(deepLinkFromNotification(const <String, dynamic>{'data': 'not a map'}), isNull);
      expect(deepLinkFromNotification(null), isNull);
      expect(deepLinkFromNotification('a string'), isNull);
      // …and every one of those goes on to be the inbox, which is the point.
      expect(parseDeepLink(deepLinkFromNotification(null)).isInbox, isTrue);
    });

    test('the data key is the one spelling the server publishes', () {
      expect(deepLinkDataKey, 'deepLink');
    });
  });
}
