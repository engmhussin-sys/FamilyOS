import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design_system/design_system.dart';
import '../../../core/localization/locale_controller.dart';
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
/// The fuller flow in the product brief — child picks a domain, the Smart
/// Reward Engine proposes a suitable activity and duration inside it — needs
/// a child-facing route that does not exist. `reward-programs` is parent-only
/// (`@Controller('reward-programs')`, parent guard), and the only two
/// `self/*` controllers are `self/achievements` and `self/coach`; neither
/// serves a catalogue or an activity proposal. That is recorded as a backend
/// gap, NOT faked on the device: a client that invented a suggestion would be
/// a client deciding what a child should study, which is the server's job and
/// the parent's decision.
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
  });

  final String category;
  final int total;
  final int available;

  bool get hasSomethingToDoNow => available > 0;
}

/// Groups today's goals by category, ordered so the domains a child can
/// actually start today come first — the same "ready-now first" ordering
/// `TodayGoalsController` applies to the goals themselves, for the same
/// reason. Ties keep a stable alphabetical order so the row does not
/// reshuffle between two refreshes that returned the same day.
List<GoalDomain> domainsOf(List<TodayGoal> goals) {
  final totals = <String, int>{};
  final availables = <String, int>{};
  for (final goal in goals) {
    final category = goal.category.trim();
    if (category.isEmpty) continue;
    totals[category] = (totals[category] ?? 0) + 1;
    if (goal.available) availables[category] = (availables[category] ?? 0) + 1;
  }

  final domains = totals.entries
      .map((entry) => GoalDomain(
            category: entry.key,
            total: entry.value,
            available: availables[entry.key] ?? 0,
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
                  label: t('category.${domain.category}'),
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
