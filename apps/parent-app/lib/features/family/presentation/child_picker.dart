import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design_system/design_system.dart';
import '../../../core/di/providers.dart';
import '../../../core/errors/api_failure.dart';
import '../../../core/localization/locale_controller.dart';

/// HOW AN ID-LESS `abny://` LINK FINDS THE CHILD IT IS ABOUT — the one
/// mechanism, written once.
///
/// ---------------------------------------------------------------------------
/// THE PROBLEM IT SOLVES, AND THE PRECEDENT IT GENERALISES.
///
/// Several of this product's surfaces are configured and read PER CHILD — every
/// backend route behind them is `/children/:childId/…` or `/…/:childId` — while
/// the link that names them carries no id at all. That is not an omission in
/// the link: the server pins `notifications.data` identifier-free on purpose
/// (`e2e-13 STEP 14` asserts the persisted payload contains no `childId`), so
/// no `abny://` link will ever name a child. The screens therefore need an
/// argument the link cannot supply.
///
/// `ScreenTimeChildrenScreen` answered that first, for `abny://screen-time`, by
/// asking the FAMILY'S OWN DATA instead of guessing. This widget is that same
/// answer extracted, so `progress` and `coach` get it without a third and
/// fourth copy of the three-way resolution drifting apart:
///
///   * MORE THAN ONE CHILD → the CHILD LIST. Picking one of several on the
///     parent's behalf would be this client inventing the thing the server
///     declined to say.
///   * EXACTLY ONE CHILD → that child's screen, directly. This is NOT the same
///     act: with one child there is only one possible referent, so the
///     destination is DETERMINED BY THE FAMILY'S DATA rather than chosen here.
///     Making a parent with one child tap through a one-item list is ceremony,
///     not honesty. It is rendered by RETURNING the screen rather than by
///     pushing a route, so `DeepLinkRouter.resolve` stays pure, the back button
///     still has exactly one thing to pop, and nothing navigates as a side
///     effect of a network read landing.
///   * NO CHILDREN → an empty state that says so, never a spinner and never a
///     blank page.
///
/// ---------------------------------------------------------------------------
/// WHY THE COPY ARRIVES RESOLVED RATHER THAN AS KEYS. Every caller passes
/// SENTENCES, not `'progress.pickChildTitle'`. A widget that took key names
/// would move the `t('…')` call sites inside a variable, and
/// `scripts/verify_l10n_parity.py` verifies LITERAL call sites — a key that
/// only ever appears as a constructor argument would stop being checked, which
/// is how a missing translation reaches a screen. The keys therefore stay
/// literal in each caller, next to the screen they belong to.
class ChildPicker extends ConsumerWidget {
  const ChildPicker({
    super.key,
    required this.title,
    required this.hint,
    required this.errorTitle,
    required this.emptyTitle,
    required this.emptyBody,
    required this.icon,
    required this.childScreenBuilder,
  });

  /// The app-bar title, already translated.
  final String title;

  /// One line above the list saying why a choice is being asked for.
  final String hint;

  /// The heading over `GET /children` failing. The BODY of that failure is the
  /// server's own sentence, never this app's.
  final String errorTitle;

  final String emptyTitle;
  final String emptyBody;

  /// The leading glyph on each row — the surface's own icon, so the list looks
  /// like the thing it leads to.
  final IconData icon;

  /// The child-scoped screen this picker exists to reach. Called with a real
  /// `childId` and a display name, which is exactly what the link could not
  /// carry.
  final Widget Function(String childId, String childName) childScreenBuilder;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    ref.watch(localeControllerProvider);
    final locale = ref.watch(localeControllerProvider.notifier);
    final t = locale.t;
    final children = ref.watch(familyChildrenProvider);

    return children.when(
      loading: () => Scaffold(
        appBar: AppBar(title: Text(title)),
        body: DsLoadingState(label: t('common.loading')),
      ),
      error: (error, _) => Scaffold(
        appBar: AppBar(title: Text(title)),
        body: DsErrorState(
          // `familyChildrenProvider` is a plain `FutureProvider` over
          // `DashboardApi`, so its error arrives as a raw `Object` rather than
          // the `ApiFailure` a repository-backed controller produces.
          // `ApiFailure.from` reads the B3 envelope out of an `ApiException`,
          // so the server's `messageAr` survives the crossing — and a
          // non-envelope error becomes the reviewed «تعذّر إتمام الطلب»
          // sentence rather than transport text. No `e.toString()` reaches a
          // parent from here.
          failure: ApiFailure.from(error),
          title: errorTitle,
          retryLabel: t('common.retry'),
          requestIdLabel: t('common.requestId'),
          arabic: locale.isRtl,
          onRetry: () => ref.invalidate(familyChildrenProvider),
        ),
      ),
      data: (rows) {
        final entries = childPickerEntries(rows);

        if (entries.isEmpty) {
          return Scaffold(
            appBar: AppBar(title: Text(title)),
            body: DsEmptyState(
              title: emptyTitle,
              body: emptyBody,
              icon: Icons.family_restroom_outlined,
            ),
          );
        }

        // EXACTLY ONE CHILD — see the header. That child's screen IS this
        // route.
        if (entries.length == 1) {
          return childScreenBuilder(entries.first.id, entries.first.name);
        }

        return Scaffold(
          appBar: AppBar(title: Text(title)),
          body: ListView(
            padding: DsSpace.screen,
            children: [
              Text(hint, style: DsText.caption(context)),
              DsSpace.gapMd,
              for (final entry in entries)
                DsCard(
                  onTap: () => Navigator.of(context).push(
                    MaterialPageRoute<void>(
                      builder: (_) => childScreenBuilder(entry.id, entry.name),
                    ),
                  ),
                  child: Row(
                    children: [
                      Icon(icon, color: DsColor.accent),
                      DsSpace.hGapMd,
                      Expanded(
                        child: Text(
                          entry.name.isEmpty ? t('childDetail.unnamed') : entry.name,
                          style: DsText.cardTitle(context),
                        ),
                      ),
                      DsIcons.disclosure(context),
                    ],
                  ),
                ),
            ],
          ),
        );
      },
    );
  }
}

/// The two fields a picker needs off a `GET /children` row. Parsed rather than
/// indexed at the call site, so a row missing `firstName` is a child with a
/// blank name instead of a `TypeError` three widgets deep — and a row with no
/// `id` is dropped, because a card that cannot name a child cannot open one.
class ChildPickerEntry {
  const ChildPickerEntry({required this.id, required this.name});

  final String id;
  final String name;
}

/// Exposed for the same reason it is a function rather than an inline `map`:
/// «a row without an id is dropped» is a claim a unit test can make without
/// pumping a widget.
List<ChildPickerEntry> childPickerEntries(List<dynamic> rows) => rows
    .whereType<Map<String, dynamic>>()
    .map((row) {
      final first = row['firstName']?.toString() ?? '';
      final last = row['lastName']?.toString() ?? '';
      return ChildPickerEntry(
        id: row['id']?.toString() ?? '',
        name: '$first $last'.trim(),
      );
    })
    .where((entry) => entry.id.isNotEmpty)
    .toList();
