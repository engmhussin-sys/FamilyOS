import 'package:flutter_test/flutter_test.dart';

import 'package:child_app/features/goals/domain/child_goal.dart';
import 'package:child_app/features/goals/presentation/domain_chooser.dart';

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
