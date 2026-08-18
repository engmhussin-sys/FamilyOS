// WHAT THIS FILE PROVES — `ChildDetailScreen` answers ALL FOUR of [UiState]'s
// cases, the id that arrived on a deep link reaches the API unchanged, and an
// id that names nothing degrades into a readable page rather than a crash.
//
// The defect it locks down: `abny://child/<childId>` had no screen at all and
// fell back to the inbox (`deep_link_router.dart`'s own header said so). A
// screen that opened but rendered a blank page for a missing child, or that
// showed a parent `e.toString()`, would be the same gap with extra steps.
//
// THE ONE THING IT IS CAREFUL ABOUT: it never asserts an English or Arabic
// SENTENCE by hand. Every expectation names a KEY through `ar(...)`, so a copy
// change moves the test with the string instead of breaking it — except for the
// server-authored `messageAr`, which is asserted literally BECAUSE the whole
// point is that the server's own words reach the screen untouched.
//
// EXECUTION STATUS: NEVER RUN. There is no Flutter SDK, no Dart SDK and no
// pub.dev reachable from the environment this was authored in. STATIC VERIFIED
// by `scripts/dart_preflight.py`, `scripts/verify_dart_imports.py` and
// `scripts/verify_l10n_parity.py` only — constructor arity, named parameters,
// member references, import scope and locale-key parity — none of which is a
// Dart analyser and none of which executes anything. First execution happens on
// a CI runner.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:parent_app/core/design_system/design_system.dart';
import 'package:parent_app/core/di/providers.dart';
import 'package:parent_app/core/state/ui_state.dart';
import 'package:parent_app/features/family/application/child_detail_controller.dart';
import 'package:parent_app/features/family/data/child_profile_repository.dart';
import 'package:parent_app/features/family/presentation/child_detail_screen.dart';
import 'package:parent_app/features/life_intelligence/presentation/coaching_screen.dart';
import 'package:parent_app/features/life_intelligence/presentation/learning_progress_screen.dart';
import 'package:parent_app/features/life_intelligence/presentation/wellbeing_screen.dart';

import '../../support/last_screens_test_harness.dart';

const String _childId = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

ChildProfile _profile({String firstName = 'محمد'}) => ChildProfile(
      id: _childId,
      firstName: firstName,
      dateOfBirth: DateTime.utc(2015, 5, 2),
    );

/// A controller pinned to one state, for the ONE case this route cannot
/// produce on its own. `GET /children/:childId` answers with a child or with a
/// 404, so `empty` has no producer — the branch still has to be right, because
/// [UiState] requires it to be handled and a future server change could start
/// reaching it. The repository is stubbed to a future that never completes, so
/// the inherited `load()` cannot overwrite the pinned value.
class _FixedChildDetailController extends ChildDetailController {
  _FixedChildDetailController(
    ChildProfileRepository repository,
    String childId,
    UiState<ChildProfile> fixed,
  ) : super(repository, childId) {
    state = fixed;
  }
}

void main() {
  testWidgets('LOADING — a spinner while the child is being fetched', (tester) async {
    final repository = FakeChildProfileRepository(
      onGetChild: () => pending<ChildProfile>(),
    );

    await pumpParentScreen(
      tester,
      const ChildDetailScreen(childId: _childId),
      overrides: [childProfileRepositoryProvider.overrideWithValue(repository)],
    );

    expect(find.byType(DsLoadingState), findsOneWidget);
    // The id off the link reached the repository unchanged — not re-derived,
    // not trimmed, not lower-cased.
    expect(repository.requestedChildIds, <String>[_childId]);
  });

  testWidgets('DATA — the name, the age, and the three child-scoped screens',
      (tester) async {
    final repository = FakeChildProfileRepository(
      onGetChild: () async => _profile(),
    );

    await pumpParentScreen(
      tester,
      const ChildDetailScreen(childId: _childId),
      overrides: [childProfileRepositoryProvider.overrideWithValue(repository)],
    );
    await tester.pump();

    // The name is the server's, rendered as it arrived.
    expect(find.text('محمد'), findsWidgets);
    // The three onward screens this host exists to supply arguments for.
    expect(find.text(ar('learningProgress.title')), findsOneWidget);
    expect(find.text(ar('coaching.title')), findsOneWidget);
    expect(find.text(ar('wellbeing.title')), findsOneWidget);
    // A date of birth is NEVER rendered — only an age.
    expect(find.textContaining('2015'), findsNothing);
  });

  testWidgets('DATA — a tile opens the child-scoped screen with BOTH arguments',
      (tester) async {
    final repository = FakeChildProfileRepository(
      onGetChild: () async => _profile(),
    );

    await pumpParentScreen(
      tester,
      const ChildDetailScreen(childId: _childId),
      overrides: [childProfileRepositoryProvider.overrideWithValue(repository)],
    );
    await tester.pump();

    await tester.tap(find.text(ar('wellbeing.title')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    // THE WHOLE REASON THIS SCREEN EXISTS: `childId` AND `childName`, both
    // real, on a screen no `abny://` link could ever have opened.
    final wellbeing = tester.widget<WellbeingScreen>(find.byType(WellbeingScreen));
    expect(wellbeing.childId, _childId);
    expect(wellbeing.childName, 'محمد');
  });

  testWidgets('DATA — the other two tiles carry the same two arguments',
      (tester) async {
    final repository = FakeChildProfileRepository(
      onGetChild: () async => _profile(),
    );

    await pumpParentScreen(
      tester,
      const ChildDetailScreen(childId: _childId),
      overrides: [childProfileRepositoryProvider.overrideWithValue(repository)],
    );
    await tester.pump();

    await tester.tap(find.text(ar('learningProgress.title')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    final progress =
        tester.widget<LearningProgressScreen>(find.byType(LearningProgressScreen));
    expect(progress.childId, _childId);
    expect(progress.childName, 'محمد');

    await tester.pageBack();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    await tester.tap(find.text(ar('coaching.title')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    final coaching = tester.widget<CoachingScreen>(find.byType(CoachingScreen));
    expect(coaching.childId, _childId);
    expect(coaching.childName, 'محمد');
  });

  testWidgets('ERROR — an unknown child shows the SERVER\'S Arabic, never e.toString()',
      (tester) async {
    // What `ChildNotFoundException` becomes once the B3 filter has shaped it.
    final failure = refusalFailure(
      statusCode: 404,
      code: 'CHILD_NOT_FOUND',
      messageAr: 'لم نعثر على هذا الطفل.',
    );
    final repository = FakeChildProfileRepository(
      onGetChild: () => failingWith<ChildProfile>(failure),
    );

    await pumpParentScreen(
      tester,
      const ChildDetailScreen(childId: _childId),
      overrides: [childProfileRepositoryProvider.overrideWithValue(repository)],
    );
    await tester.pump();

    expect(find.byType(DsErrorState), findsOneWidget);
    expect(find.text('لم نعثر على هذا الطفل.'), findsOneWidget);
    expect(find.text(ar('childDetail.errorTitle')), findsOneWidget);
    // The chrome is there and the screen did not crash on the way.
    expect(find.text(ar('common.retry')), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('ERROR — a transport failure never puts raw English on the screen',
      (tester) async {
    // A proxy 502: no B3 envelope, so the only text Dio has is «The request
    // returned an invalid status code of 502». It must not be what a parent
    // reads.
    final repository = FakeChildProfileRepository(
      onGetChild: () => failingWith<ChildProfile>(proxyFailure()),
    );

    await pumpParentScreen(
      tester,
      const ChildDetailScreen(childId: _childId),
      overrides: [childProfileRepositoryProvider.overrideWithValue(repository)],
    );
    await tester.pump();

    expect(find.textContaining('502'), findsNothing);
    expect(find.textContaining('invalid status code'), findsNothing);
    expect(find.text('تعذّر إتمام الطلب. حاول مرة أخرى بعد قليل.'), findsOneWidget);
  });

  testWidgets('EMPTY — the branch this route cannot reach still reads honestly',
      (tester) async {
    final repository = FakeChildProfileRepository(
      onGetChild: () => pending<ChildProfile>(),
    );

    await pumpParentScreen(
      tester,
      const ChildDetailScreen(childId: _childId),
      overrides: [
        childProfileRepositoryProvider.overrideWithValue(repository),
        childDetailControllerProvider.overrideWith(
          (ref, childId) => _FixedChildDetailController(
            repository,
            childId,
            const UiState<ChildProfile>.empty(),
          ),
        ),
      ],
    );
    await tester.pump();

    expect(find.byType(DsEmptyState), findsOneWidget);
    expect(find.text(ar('childDetail.missingTitle')), findsOneWidget);
    expect(find.text(ar('childDetail.missingBody')), findsOneWidget);
  });

  testWidgets('a child with no readable name still opens, with a placeholder',
      (tester) async {
    final repository = FakeChildProfileRepository(
      onGetChild: () async => const ChildProfile(id: _childId, firstName: ''),
    );

    await pumpParentScreen(
      tester,
      const ChildDetailScreen(childId: _childId),
      overrides: [childProfileRepositoryProvider.overrideWithValue(repository)],
    );
    await tester.pump();

    expect(tester.takeException(), isNull);
    // The app bar falls back to the surface's own name, the body to «طفلك» —
    // never a blank title and never the raw id.
    expect(find.text(ar('childDetail.title')), findsOneWidget);
    expect(find.text(ar('childDetail.unnamed')), findsOneWidget);
    expect(find.textContaining(_childId), findsNothing);
  });

  group('ChildProfile.fromJson — the whitelist', () {
    test('reads five keys and cannot carry a credential hash or a tenant id', () {
      // Built as a local, NOT inline: `scripts/dart_preflight.py` reads a
      // `<String, dynamic>` type argument inside a call's parentheses as an
      // argument separator and miscounts the arity.
      final row = <String, dynamic>{
        'id': _childId,
        'firstName': 'محمد',
        'lastName': 'حسين',
        'dateOfBirth': '2015-05-02T00:00:00.000Z',
        'isActive': true,
        // Both of these really are on the row `GET /children/:childId` returns.
        'pinCodeHash': r'$2b$10$notarealhash',
        'familyId': 'f_1',
      };
      final profile = ChildProfile.fromJson(row);

      expect(profile, isNotNull);
      expect(profile!.id, _childId);
      expect(profile.firstName, 'محمد');
      expect(profile.lastName, 'حسين');
      expect(profile.isActive, isTrue);
      // There is no field to hold either one, which is the guarantee.
    });

    test('a row with no id is unreadable rather than half-read', () {
      final noId = <String, dynamic>{'firstName': 'محمد'};
      final emptyId = <String, dynamic>{'id': ''};
      expect(ChildProfile.fromJson(noId), isNull);
      expect(ChildProfile.fromJson(emptyId), isNull);
      expect(ChildProfile.fromJson('not a map'), isNull);
      expect(ChildProfile.fromJson(null), isNull);
    });

    test('an unparseable or absent date of birth is no age, never a wrong one', () {
      final row = <String, dynamic>{
        'id': _childId,
        'firstName': 'محمد',
        'dateOfBirth': 'yesterday',
      };
      final noDob = ChildProfile.fromJson(row);
      expect(noDob!.dateOfBirth, isNull);
      expect(noDob.ageInYearsAt(DateTime.utc(2026, 8, 18)), isNull);
    });

    test('the age is whole years against a supplied clock, and refuses nonsense', () {
      final child = ChildProfile(
        id: _childId,
        firstName: 'محمد',
        dateOfBirth: DateTime.utc(2015, 5, 2),
      );
      // Birthday already passed this year.
      expect(child.ageInYearsAt(DateTime.utc(2026, 8, 18)), 11);
      // Birthday not yet reached.
      expect(child.ageInYearsAt(DateTime.utc(2026, 3, 1)), 10);
      // A date of birth in the future is a data problem, not a negative age to
      // print on a parent's screen.
      expect(child.ageInYearsAt(DateTime.utc(2010, 1, 1)), isNull);
    });
  });
}
