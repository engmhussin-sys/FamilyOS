import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design_system/design_system.dart';
import '../../../core/localization/locale_controller.dart';
import '../domain/catalogue_domain.dart';
import '../domain/child_goal.dart';

/// «إيه اللي عايز تتعلمه النهاردة؟» — THE DOMAIN CHOOSER.
///
/// CLOSES CHILD MVP CAPABILITY 5. Before this, `category` existed in the app
/// only as a read-only label printed on a goal card; a child had no way to
/// say what they felt like doing. They were handed a flat list and expected
/// to read it.
///
/// WHAT THIS IS, PRECISELY — and the limit is worth stating rather than
/// implying. This chooses among the domains the PARENT has programmed for
/// today. It is a chooser over real goals, not a request for a new one:
/// tapping «القرآن» shows the Quran goals that exist, and does not conjure
/// one if none does.
///
/// THE ROW NOW COMES FROM THE SERVER. This file used to say that the real
/// catalogue route did not exist and that the domains were therefore derived
/// from whatever categories happened to appear in today's goals — so a child
/// with two Quran goals was shown a product with exactly one subject in it,
/// and could not learn that SCIENCE or PROGRAMMING existed at all.
/// `GET /self/catalogue/domains` exists now, and [domainsFromCatalogue] uses
/// it: the domain vocabulary, in the server's own Arabic, at this child's own
/// age band, with today's goals counted into it.
///
/// WHAT HAS NOT CHANGED, AND MUST NOT. This is still a chooser over the goals
/// a PARENT has programmed. Tapping «القرآن» shows the Quran goals that
/// exist; it does not conjure one, does not request one, and does not start
/// anything nobody programmed. A domain with nothing today says so plainly
/// and names the way forward («كلّم ولي أمرك»), because the way forward is a
/// person, not a button. See `catalogue_api.dart` for why the activity lists
/// on `GET /self/catalogue` are deliberately not rendered here.
///
/// A domain with nothing available today is DIMMED, never hidden and never
/// locked — the same treatment `GoalCard` gives an unavailable goal, for the
/// same reason (it is still theirs, it is just not now).

/// Material icons, not emoji.
///
/// The brief sketches this row with emoji (📖 ⚽ 🔬 💻). Icons ship inside the
/// app; emoji resolve against whatever emoji font the device has, and on the
/// cheap Android hardware this product targets, partial coverage renders as a
/// blank box — on the one row whose entire job is to be recognised at a
/// glance by a six-year-old who may not read fluently yet. If the emoji row
/// is wanted, it is a deliberate swap of this map, not a default.
const Map<String, IconData> _categoryIcons = {
  'QURAN': Icons.menu_book_rounded,
  'HADITH': Icons.auto_stories_rounded,
  'FIQH': Icons.mosque_rounded,
  'ARABIC': Icons.abc_rounded,
  'ENGLISH': Icons.translate_rounded,
  'MATH': Icons.calculate_rounded,
  'SCIENCE': Icons.science_rounded,
  'PROGRAMMING': Icons.code_rounded,
  'READING': Icons.local_library_rounded,
  'SPORT': Icons.directions_run_rounded,
  'HEALTH': Icons.favorite_rounded,
  'HABITS': Icons.repeat_rounded,
  'MANNERS': Icons.handshake_rounded,
  'HOUSEWORK': Icons.cleaning_services_rounded,
  'CREATIVITY': Icons.palette_rounded,
  'SKILLS': Icons.construction_rounded,
  'STUDY': Icons.school_rounded,
  'VOLUNTEERING': Icons.volunteer_activism_rounded,
};

/// A category this build has never heard of still gets a chip and a readable
/// label — `t('category.<CODE>')` falls back to the key, and a generic icon
/// beats an empty square. A new server-side category must degrade, not vanish.
IconData iconForCategory(String category) =>
    _categoryIcons[category] ?? Icons.star_rounded;

/// One domain and how many of today's goals sit inside it.
class GoalDomain {
  const GoalDomain({
    required this.category,
    required this.total,
    required this.available,
    this.labelAr,
  });

  final String category;
  final int total;
  final int available;

  /// The SERVER'S Arabic name for this domain, when the catalogue supplied
  /// one. Rendered verbatim; `null` falls back to this app's own
  /// `category.*` string.
  final String? labelAr;

  bool get hasSomethingToDoNow => available > 0;

  /// True when the catalogue lists this domain but the parent has programmed
  /// nothing in it today. Not a failure and not the child's fault — it is the
  /// case the empty-state sentence exists for.
  bool get hasNothingToday => total == 0;
}

/// Counts today's goals per category. Shared by both builders below so
/// «how many goals are in this domain» has exactly one implementation.
Map<String, List<int>> _countsByCategory(List<TodayGoal> goals) {
  final counts = <String, List<int>>{};
  for (final goal in goals) {
    final category = goal.category.trim();
    if (category.isEmpty) continue;
    final entry = counts.putIfAbsent(category, () => <int>[0, 0]);
    entry[0] += 1;
    if (goal.available) entry[1] += 1;
  }
  return counts;
}

/// Groups today's goals by category, ordered so the domains a child can
/// actually start today come first — the same "ready-now first" ordering
/// `TodayGoalsController` applies to the goals themselves, for the same
/// reason. Ties keep a stable alphabetical order so the row does not
/// reshuffle between two refreshes that returned the same day.
///
/// STILL THE FALLBACK, NOT DEAD CODE: this is what the chooser shows when
/// `GET /self/catalogue/domains` could not be read. A child whose catalogue
/// call failed keeps a working chooser over the goals they do have, rather
/// than losing the row entirely.
List<GoalDomain> domainsOf(List<TodayGoal> goals) {
  final counts = _countsByCategory(goals);

  final domains = counts.entries
      .map((entry) => GoalDomain(
            category: entry.key,
            total: entry.value[0],
            available: entry.value[1],
          ))
      .toList();

  domains.sort((a, b) {
    if (a.hasSomethingToDoNow != b.hasSomethingToDoNow) {
      return a.hasSomethingToDoNow ? -1 : 1;
    }
    return a.category.compareTo(b.category);
  });
  return domains;
}

/// THE REAL VOCABULARY, WITH TODAY'S GOALS COUNTED INTO IT.
///
/// [catalogue] is `GET /self/catalogue/domains` in the order the server sent
/// it — which already puts the domains it suggests at this child's age first,
/// stably. That order is preserved here; the only re-ordering is the one this
/// row has always applied, «what you can start now, first», so a child does
/// not scroll past a dozen dim chips to reach the one they can tap. Within
/// each of those two groups the server's order is kept exactly, which is what
/// makes two refreshes of the same day render the same row.
///
/// A category that appears in today's goals but NOT in the catalogue is still
/// listed, at the end. That should not happen — both come from the same
/// server — but a real goal a child can start must never be unreachable
/// because a chip was missing.
///
/// An empty [catalogue] (the call failed, or the body was malformed) falls
/// back to [domainsOf].
List<GoalDomain> domainsFromCatalogue(
  List<CatalogueDomainRow> catalogue,
  List<TodayGoal> goals,
) {
  if (catalogue.isEmpty) return domainsOf(goals);

  final counts = _countsByCategory(goals);
  final domains = <GoalDomain>[];
  final listed = <String>{};

  for (final row in catalogue) {
    if (!listed.add(row.code)) continue;
    final entry = counts[row.code];
    domains.add(GoalDomain(
      category: row.code,
      labelAr: row.labelAr,
      total: entry?[0] ?? 0,
      available: entry?[1] ?? 0,
    ));
  }

  for (final entry in counts.entries) {
    if (listed.contains(entry.key)) continue;
    domains.add(GoalDomain(
      category: entry.key,
      total: entry.value[0],
      available: entry.value[1],
    ));
  }

  final order = <String, int>{
    for (var i = 0; i < domains.length; i++) domains[i].category: i,
  };
  domains.sort((a, b) {
    if (a.hasSomethingToDoNow != b.hasSomethingToDoNow) {
      return a.hasSomethingToDoNow ? -1 : 1;
    }
    // `List.sort` is not stable, so the server's order is restored
    // explicitly rather than assumed.
    return order[a.category]!.compareTo(order[b.category]!);
  });
  return domains;
}

class DomainChooser extends ConsumerWidget {
  const DomainChooser({
    super.key,
    required this.domains,
    required this.selected,
    required this.onSelected,
  });

  final List<GoalDomain> domains;

  /// `null` means «كل حاجة» — no filter.
  final String? selected;

  final ValueChanged<String?> onSelected;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = ref.watch(localeControllerProvider.notifier).t;

    // One domain is not a choice. Showing a chooser with a single chip and an
    // "everything" chip that select the same set is chrome pretending to be a
    // feature.
    if (domains.length < 2) return const SizedBox.shrink();

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(t('today.chooseDomain'), style: KidText.sectionTitle(context)),
        KidSpace.gapSm,
        SizedBox(
          height: 96,
          // A horizontal ListView follows the ambient Directionality, so this
          // starts at the right in Arabic without any per-locale branching.
          child: ListView(
            scrollDirection: Axis.horizontal,
            children: [
              _DomainChip(
                label: t('today.allDomains'),
                icon: Icons.apps_rounded,
                isSelected: selected == null,
                isDim: false,
                onTap: () => onSelected(null),
              ),
              for (final domain in domains)
                _DomainChip(
                  // SERVER ARABIC WINS, VERBATIM. `labelAr` was written for
                  // this child's age band and has already passed the safety
                  // engine; routing it through `t()` would replace a filtered
                  // sentence with an unfiltered one. The app's own key is the
                  // fallback for a catalogue that could not be read — and for
                  // a category the catalogue never listed.
                  label: domain.labelAr ?? t('category.${domain.category}'),
                  icon: iconForCategory(domain.category),
                  isSelected: selected == domain.category,
                  isDim: !domain.hasSomethingToDoNow,
                  onTap: () => onSelected(domain.category),
                ),
            ],
          ),
        ),
      ],
    );
  }
}

class _DomainChip extends StatelessWidget {
  const _DomainChip({
    required this.label,
    required this.icon,
    required this.isSelected,
    required this.isDim,
    required this.onTap,
  });

  final String label;
  final IconData icon;
  final bool isSelected;
  final bool isDim;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final color = isSelected ? KidColor.primary : KidColor.mutedInk;
    return Padding(
      padding: const EdgeInsets.only(right: KidSpace.sm),
      child: Semantics(
        button: true,
        selected: isSelected,
        label: label,
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(KidRadius.card),
          child: Opacity(
            opacity: isDim ? 0.62 : 1,
            child: Container(
              width: 92,
              padding: const EdgeInsets.symmetric(
                vertical: KidSpace.sm,
                horizontal: KidSpace.xs,
              ),
              decoration: BoxDecoration(
                color: isSelected ? KidColor.primary.withOpacity(0.12) : KidColor.surface,
                borderRadius: BorderRadius.circular(KidRadius.card),
                border: Border.all(
                  color: isSelected ? KidColor.primary : KidColor.hairline,
                  width: isSelected ? 2 : 1,
                ),
              ),
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Icon(icon, size: 32, color: color),
                  KidSpace.gapXs,
                  Text(
                    label,
                    style: KidText.caption(context),
                    textAlign: TextAlign.center,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
