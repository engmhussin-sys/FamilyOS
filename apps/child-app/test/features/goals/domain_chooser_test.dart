// EXECUTION STATUS: NEVER RUN. No Flutter or Dart SDK is reachable from the
// environment the catalogue half of this file was authored in. STATIC
// VERIFIED by `scripts/dart_preflight.py` only, which executes nothing.

import 'package:flutter_test/flutter_test.dart';

import 'package:child_app/core/errors/api_failure.dart';
import 'package:child_app/core/network/api_client.dart';
import 'package:child_app/core/network/api_exception.dart';
import 'package:child_app/features/goals/api/catalogue_api.dart';
import 'package:child_app/features/goals/data/catalogue_repository.dart';
import 'package:child_app/features/goals/domain/catalogue_domain.dart';
import 'package:child_app/features/goals/domain/child_goal.dart';
import 'package:child_app/features/goals/presentation/domain_chooser.dart';

CatalogueDomainRow _row(String code, {String? labelAr, bool suggested = true}) =>
    CatalogueDomainRow(
      code: code,
      labelAr: labelAr,
      suggestedAtThisAge: suggested,
    );

/// Records the paths asked for, so a test can assert that the chooser reads
/// the domains-only route and NEVER the one carrying activity items.
class _RecordingClient implements ApiClient {
  final List<String> getPaths = [];

  Map<String, dynamic> body = const <String, dynamic>{};
  Object? error;

  @override
  Future<Map<String, dynamic>> get(String path) async {
    getPaths.add(path);
    final failure = error;
    if (failure != null) throw failure;
    return body;
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

TodayGoal _goal({
  required String category,
  bool available = true,
  String programId = 'p',
}) {
  return TodayGoal(
    programId: '$programId-$category-$available',
    category: category,
    activity: 'ACTIVITY',
    targetSummaryAr: 'هدف',
    durationMinutes: 20,
    reward: const GoalReward(type: 'POINTS', amount: 20),
    verificationLevel: 'SELF_CHECK',
    available: available,
  );
}

void main() {
  group('domainsOf', () {
    test('counts totals and availables per domain', () {
      final domains = domainsOf([
        _goal(category: 'QURAN'),
        _goal(category: 'QURAN', available: false),
        _goal(category: 'SPORT'),
      ]);

      final quran = domains.firstWhere((d) => d.category == 'QURAN');
      expect(quran.total, 2);
      expect(quran.available, 1);
      expect(quran.hasSomethingToDoNow, isTrue);
    });

    test('a domain with nothing startable today is still listed', () {
      final domains = domainsOf([
        _goal(category: 'SCIENCE', available: false),
      ]);

      expect(domains.single.category, 'SCIENCE');
      expect(domains.single.hasSomethingToDoNow, isFalse,
          reason: 'the chooser dims it — it never hides it');
    });

    test('domains a child can start today come first', () {
      final domains = domainsOf([
        _goal(category: 'AAA_BLOCKED', available: false),
        _goal(category: 'ZZZ_READY'),
      ]);

      expect(domains.first.category, 'ZZZ_READY');
      expect(domains.last.category, 'AAA_BLOCKED');
    });

    test('ties are alphabetical, so two identical refreshes do not reshuffle the row', () {
      final first = domainsOf([
        _goal(category: 'SPORT'),
        _goal(category: 'MATH'),
        _goal(category: 'QURAN'),
      ]).map((d) => d.category);
      final second = domainsOf([
        _goal(category: 'QURAN'),
        _goal(category: 'SPORT'),
        _goal(category: 'MATH'),
      ]).map((d) => d.category);

      expect(first, ['MATH', 'QURAN', 'SPORT']);
      expect(second, first);
    });

    test('a goal with no category is not turned into a blank chip', () {
      final domains = domainsOf([
        _goal(category: ''),
        _goal(category: '   '),
        _goal(category: 'HABITS'),
      ]);

      expect(domains.map((d) => d.category), ['HABITS']);
    });

    test('no goals means no domains — the chooser renders nothing', () {
      expect(domainsOf(const []), isEmpty);
    });
  });

  // ---------------------------------------------------------------------
  // THE REAL CATALOGUE — `GET /self/catalogue/domains`.
  //
  // What these lock down: a child sees the whole domain vocabulary in the
  // server's own Arabic, today's goals are still what the row filters, and a
  // catalogue that cannot be read costs the child nothing.
  // ---------------------------------------------------------------------
  group('domainsFromCatalogue', () {
    test('shows every domain the server lists, even with no goal today', () {
      final domains = domainsFromCatalogue(
        [_row('QURAN'), _row('PROGRAMMING'), _row('SPORT')],
        [_goal(category: 'QURAN')],
      );

      expect(domains.map((d) => d.category),
          containsAll(<String>['QURAN', 'PROGRAMMING', 'SPORT']));
      final programming = domains.firstWhere((d) => d.category == 'PROGRAMMING');
      expect(programming.hasNothingToday, isTrue);
      expect(programming.hasSomethingToDoNow, isFalse,
          reason: 'dimmed — never hidden, never locked');
    });

    test('renders the server’s Arabic label, and never invents one', () {
      final domains = domainsFromCatalogue(
        [_row('QURAN', labelAr: 'قرآن'), _row('FIQH')],
        const <TodayGoal>[],
      );

      expect(domains.firstWhere((d) => d.category == 'QURAN').labelAr, 'قرآن');
      // No label from the server means the chip falls back to the app's own
      // `category.*` string — it does not fabricate Arabic.
      expect(domains.firstWhere((d) => d.category == 'FIQH').labelAr, isNull);
    });

    test('today’s goals are still what the counts are made of', () {
      final domains = domainsFromCatalogue(
        [_row('QURAN'), _row('SPORT')],
        [
          _goal(category: 'QURAN'),
          _goal(category: 'QURAN', available: false),
        ],
      );

      final quran = domains.firstWhere((d) => d.category == 'QURAN');
      expect(quran.total, 2);
      expect(quran.available, 1);
      expect(domains.firstWhere((d) => d.category == 'SPORT').total, 0);
    });

    test('domains a child can start today come first, then the server’s order', () {
      final domains = domainsFromCatalogue(
        [_row('QURAN'), _row('SCIENCE'), _row('SPORT'), _row('MATH')],
        [_goal(category: 'SPORT')],
      );

      expect(domains.first.category, 'SPORT');
      // Everything else keeps the order the server sent, not an alphabetical
      // one and not a random one — two refreshes must render the same row.
      expect(domains.skip(1).map((d) => d.category), ['QURAN', 'SCIENCE', 'MATH']);
    });

    test('a real goal is never unreachable because the catalogue omitted its domain', () {
      final domains = domainsFromCatalogue(
        [_row('QURAN')],
        [_goal(category: 'SOMETHING_NEW_FROM_THE_SERVER')],
      );

      expect(domains.map((d) => d.category),
          contains('SOMETHING_NEW_FROM_THE_SERVER'));
    });

    test('an unreadable catalogue falls back to the domains of today’s goals', () {
      // This is the exact value `TodayGoalsScreen` passes when
      // `catalogueDomainsProvider` is still loading or has failed.
      final domains = domainsFromCatalogue(
        const <CatalogueDomainRow>[],
        [_goal(category: 'QURAN'), _goal(category: 'SPORT', available: false)],
      );

      expect(domains.map((d) => d.category), ['QURAN', 'SPORT']);
      expect(domains.first.labelAr, isNull);
    });

    test('no catalogue and no goals means no row at all', () {
      expect(domainsFromCatalogue(const [], const []), isEmpty);
    });
  });

  group('ChildCatalogueRepository', () {
    test('reads the domains-only route, and never the one carrying items', () async {
      final client = _RecordingClient()
        ..body = <String, dynamic>{
          'domains': [
            {
              'code': 'QURAN',
              'labelAr': 'قرآن',
              'suitability': {'suggestedAtThisAge': true, 'hidden': false, 'noteAr': 'مناسب'},
            },
          ],
        };

      final rows = await ChildCatalogueRepository(ChildCatalogueApi(client)).domains();

      expect(client.getPaths, ['/self/catalogue/domains']);
      expect(client.getPaths, isNot(contains('/self/catalogue')),
          reason: 'the activity lists are deliberately not fetched — see catalogue_api.dart');
      expect(rows.single.code, 'QURAN');
      expect(rows.single.labelAr, 'قرآن');
      expect(rows.single.suggestedAtThisAge, isTrue);
    });

    test('a row with no code is dropped rather than rendered as a dead chip', () async {
      final client = _RecordingClient()
        ..body = <String, dynamic>{
          'domains': [
            {'labelAr': 'بدون رمز'},
            {'code': 'SPORT', 'labelAr': 'رياضة'},
          ],
        };

      final rows = await ChildCatalogueRepository(ChildCatalogueApi(client)).domains();

      expect(rows.map((r) => r.code), ['SPORT']);
    });

    test('a body with no domains array is an empty list, not a crash', () async {
      final client = _RecordingClient()..body = <String, dynamic>{'totals': {}};

      final rows = await ChildCatalogueRepository(ChildCatalogueApi(client)).domains();

      expect(rows, isEmpty);
    });

    test('a failed call surfaces as an ApiFailure carrying the server’s Arabic', () async {
      final client = _RecordingClient()
        ..error = ApiException(
          'Child not found.',
          404,
          code: 'CHILD_NOT_FOUND',
          messageAr: 'الطفل غير موجود.',
        );

      final repository = ChildCatalogueRepository(ChildCatalogueApi(client));

      await expectLater(
        repository.domains(),
        throwsA(isA<ApiFailure>()
            .having((f) => f.code, 'code', 'CHILD_NOT_FOUND')
            .having((f) => f.messageAr, 'messageAr', 'الطفل غير موجود.')),
      );
    });
  });

  group('iconForCategory', () {
    test('every category the app can localize has its own icon', () {
      // These are the 18 `category.*` keys in `localization_engine.dart`. A
      // category shipped in the locale map but missing from the icon map
      // would render every chip with the same fallback star, which defeats
      // the entire point of a row a pre-reader recognises by shape.
      const localizedCategories = [
        'ARABIC', 'CREATIVITY', 'ENGLISH', 'FIQH', 'HABITS', 'HADITH',
        'HEALTH', 'HOUSEWORK', 'MANNERS', 'MATH', 'PROGRAMMING', 'QURAN',
        'READING', 'SCIENCE', 'SKILLS', 'SPORT', 'STUDY', 'VOLUNTEERING',
      ];

      final icons = {
        for (final category in localizedCategories) category: iconForCategory(category),
      };

      expect(icons.values.toSet(), hasLength(localizedCategories.length),
          reason: 'no two domains share an icon, and none fell through to the fallback');
    });

    test('an unknown server-side category degrades to a generic icon, not a blank', () {
      expect(iconForCategory('SOMETHING_NEW_FROM_THE_SERVER'), isNotNull);
    });
  });
}
