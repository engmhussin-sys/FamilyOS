import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/di/providers.dart';
import '../../../core/errors/api_failure.dart';
import '../../../core/localization/locale_controller.dart';
import '../../../core/routing/app_routes.dart';
import '../../../core/theme/app_theme.dart';
import '../../family/presentation/child_detail_screen.dart';
import '../../life_intelligence/presentation/digital_twin_screen.dart';
import '../../life_intelligence/presentation/life_timeline_screen.dart';
import '../../life_intelligence/presentation/habit_tracker_screen.dart';
import '../../life_intelligence/presentation/health_trend_screen.dart';
import '../../life_intelligence/presentation/learning_progress_screen.dart';
import '../../life_intelligence/presentation/pending_approvals_screen.dart';
import '../../life_intelligence/presentation/faith_progress_screen.dart';
import '../../life_intelligence/presentation/family_store_screen.dart';
import '../../life_intelligence/presentation/coaching_screen.dart';
import '../../life_intelligence/presentation/wellbeing_screen.dart';
import '../../rewards/presentation/child_rewards_screen.dart';
import '../../rewards/presentation/programs_list_screen.dart';
import '../../rewards/presentation/suggestions_screen.dart';
import '../../../core/design_system/design_system.dart';

class DashboardHomeScreen extends ConsumerStatefulWidget {
  const DashboardHomeScreen({super.key});

  @override
  ConsumerState<DashboardHomeScreen> createState() => _DashboardHomeScreenState();
}

class _DashboardHomeScreenState extends ConsumerState<DashboardHomeScreen> {
  List<dynamic>? _children;
  List<dynamic>? _devices;
  int _unreadCount = 0;
  int _pendingApprovalsCount = 0;
  /// B6: the number of ACHIEVEMENTS waiting on this parent — a different
  /// queue from `_pendingApprovalsCount`, which counts pending MESSAGES
  /// (`/life-intelligence/communication/pending`). Audit P12 called out
  /// that the two had been conflated by name.
  int _pendingGoalReviewCount = 0;
  bool _isLoading = true;

  /// The B3 envelope, not `e.toString()`. The retry-and-explain state was
  /// already here (an earlier review added it); what was missing is the
  /// EXPLANATION — it rendered a fixed `t('common.error')` and discarded the
  /// Arabic sentence the server had already written for this exact failure.
  ApiFailure? _failure;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _isLoading = true;
      _failure = null;
    });
    final api = ref.read(dashboardApiProvider);
    try {
      final results = await Future.wait([
        api.getChildren(),
        api.getDevices(),
        api.getUnreadNotificationCount(),
      ]);
      if (!mounted) return;
      setState(() {
        _children = results[0] as List<dynamic>;
        _devices = results[1] as List<dynamic>;
        _unreadCount = results[2] as int;
        _isLoading = false;
      });
    } catch (e) {
      // PRODUCTION READINESS REVIEW FIX (UI/UX Review — Error State):
      // this catch block previously discarded the error entirely,
      // leaving `_children`/`_devices` null and `_isLoading` false —
      // which rendered as an empty dashboard indistinguishable from "no
      // children yet," silently hiding a real network/server failure
      // from the user with no way to retry.
      if (mounted) {
        setState(() {
          _isLoading = false;
          _failure = ApiFailure.from(e);
        });
      }
      return;
    }

    // CLOSES A REAL UX GAP: fetched separately with its own try/catch —
    // same "one section's failure never blocks another" discipline as
    // every other multi-fetch screen in this app. A pending-approvals
    // count failure must never prevent the already-working dashboard
    // (children/devices/unread) from rendering.
    try {
      final pending = await ref.read(lifeIntelligenceApiProvider).getPendingMessages();
      if (mounted) setState(() => _pendingApprovalsCount = pending.length);
    } catch (_) {
      // Best-effort — the dashboard already rendered successfully above.
    }

    // B6 — same partial-failure discipline: the goal-review count is its own
    // fetch with its own catch, so an F4 outage cannot blank a dashboard
    // that has already rendered.
    try {
      final reviews = await ref.read(rewardProgramsRepositoryProvider).listPendingAchievements();
      if (mounted) setState(() => _pendingGoalReviewCount = reviews.length);
    } catch (_) {
      // Best-effort.
    }
  }

  @override
  Widget build(BuildContext context) {
    ref.watch(localeControllerProvider); // registers rebuild dependency — see fix note below
    final locale = ref.watch(localeControllerProvider.notifier);
    final t = locale.t;

    return Scaffold(
      appBar: AppBar(
        title: Text(t('dashboard.title')),
        actions: [
          IconButton(
            icon: Badge(
              label: Text('$_pendingApprovalsCount'),
              isLabelVisible: _pendingApprovalsCount > 0,
              child: const Icon(Icons.mark_email_unread_outlined),
            ),
            tooltip: t('pendingApprovals.title'),
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute(builder: (_) => const PendingApprovalsScreen()),
            ),
          ),
          IconButton(
            icon: Badge(
              label: Text('$_unreadCount'),
              isLabelVisible: _unreadCount > 0,
              child: const Icon(Icons.notifications_outlined),
            ),
            tooltip: t('dashboard.notificationsTooltip'),
            onPressed: () => Navigator.of(context).pushNamed(AppRoutes.notifications),
          ),
          IconButton(
            icon: const Icon(Icons.settings_outlined),
            tooltip: t('dashboard.settingsTooltip'),
            onPressed: () => Navigator.of(context).pushNamed(AppRoutes.settings),
          ),
        ],
      ),
      body: _isLoading
          ? const Center(child: CircularProgressIndicator())
          : _failure != null
              ? Center(
                  child: SingleChildScrollView(
                    child: DsErrorState(
                      failure: _failure!,
                      title: t('common.error'),
                      retryLabel: t('common.retry'),
                      requestIdLabel: t('common.requestId'),
                      arabic: locale.isRtl,
                      onRetry: _load,
                    ),
                  ),
                )
              : RefreshIndicator(
              onRefresh: _load,
              // -------------------------------------------------------------
              // PHASE E (§6). THE ORDER OF THIS LIST IS THE FIX.
              //
              // §6 asks this one screen to answer two questions:
              //   «هل ابني بخير اليوم؟»  and  «هل هناك شيء يحتاج مني؟»
              //
              // BEFORE, the first thing a parent saw was `_FamilySummaryCard`:
              // how many children, how many DEVICES, how many alerts. That is
              // an INVENTORY — a monitoring console's opening statistic — and
              // it answers neither question. Worse, both answers sat below it
              // and were scattered: "is my child OK" lived in a risk chip
              // inside the third block, and "does anything need me" was split
              // across an app-bar badge (pending messages), a button label
              // inside the goals hub (pending reviews) and an "alerts" tile —
              // three places, none of them the top of the screen.
              //
              // AFTER: the two answers lead, in the order the questions are
              // asked, and the inventory moves below them. NOTHING IS DELETED
              // — `_FamilySummaryCard` is byte-identical and still shows every
              // number it showed before, one scroll lower, where an inventory
              // belongs.
              // -------------------------------------------------------------
              child: ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  // Question 2 first, deliberately. A parent who opens this app
                  // between two errands mostly needs to know whether they can
                  // close it again; this card answers that in one line.
                  _NeedsYouCard(
                    pendingReviews: _pendingGoalReviewCount,
                    pendingMessages: _pendingApprovalsCount,
                    t: t,
                  ),
                  const SizedBox(height: 16),
                  // Question 1: one row per child, each carrying a plain
                  // answer for that child rather than a severity code.
                  if (_children != null && _children!.isEmpty)
                    _FirstChildEmptyState(t: t)
                  else ...[
                    Padding(
                      padding: const EdgeInsets.only(bottom: 8),
                      child: Text(
                        t('dashboard.childStatusTitle'),
                        style: Theme.of(context).textTheme.titleMedium,
                      ),
                    ),
                    ...?_children?.map((child) => _ChildCard(child: child, devices: _devices ?? [], t: t)),
                  ],
                  const SizedBox(height: 16),
                  _GoalsHubCard(t: t, pendingReviews: _pendingGoalReviewCount),
                  const SizedBox(height: 16),
                  _FamilySummaryCard(
                    childrenCount: _children?.length ?? 0,
                    devicesCount: _devices?.length ?? 0,
                    alertsCount: _unreadCount,
                    t: t,
                  ),
                  const SizedBox(height: 16),
                  _QuickActions(t: t),
                ],
              ),
            ),
    );
  }
}

/// PHASE E (§6) — «هل هناك شيء يحتاج مني؟», answered in one block.
///
/// Both queues this card reads already existed and were already fetched by
/// `_load`; what did not exist was a single place that ANSWERS the question.
/// `_pendingGoalReviewCount` (achievements waiting on this parent) was only
/// legible as a number inside a button label in the goals hub, and
/// `_pendingApprovalsCount` (messages waiting on this parent) only as a badge
/// on an app-bar icon. A parent had to know to look in two places, and to know
/// that the two counts mean different things — which audit P12 already
/// recorded as having been conflated once by name.
///
/// WHEN BOTH ARE ZERO THIS CARD STILL RENDERS, and says so. "Nothing is
/// waiting for you" is a real answer to the question and the most common one;
/// hiding the card would make its absence indistinguishable from a screen that
/// had not finished loading.
class _NeedsYouCard extends StatelessWidget {
  const _NeedsYouCard({
    required this.pendingReviews,
    required this.pendingMessages,
    required this.t,
  });

  final int pendingReviews;
  final int pendingMessages;
  final String Function(String, {int? count, Map<String, Object>? options}) t;

  @override
  Widget build(BuildContext context) {
    final total = pendingReviews + pendingMessages;
    final calm = total == 0;
    final accent = calm ? AppTheme.sage500 : AppTheme.amber500;

    return DsCard(
      accent: accent,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(calm ? Icons.check_circle_outline_rounded : Icons.pending_actions_rounded,
                  color: accent, size: 22),
              const SizedBox(width: 8),
              Expanded(
                child: Text(t('dashboard.needsYouTitle'), style: DsText.sectionTitle(context)),
              ),
            ],
          ),
          DsSpace.gapSm,
          if (calm)
            Text(t('dashboard.needsYouNothing'), style: DsText.caption(context))
          else ...[
            if (pendingReviews > 0)
              _NeedsYouRow(
                icon: Icons.fact_check_outlined,
                label: t('dashboard.needsYouReviews', options: {'count': pendingReviews}),
                onTap: () => Navigator.of(context).pushNamed(AppRoutes.goalReviewQueue),
              ),
            if (pendingMessages > 0)
              _NeedsYouRow(
                icon: Icons.mark_email_unread_outlined,
                label: t('dashboard.needsYouMessages', options: {'count': pendingMessages}),
                onTap: () => Navigator.of(context).push(
                  MaterialPageRoute(builder: (_) => const PendingApprovalsScreen()),
                ),
              ),
          ],
        ],
      ),
    );
  }
}

class _NeedsYouRow extends StatelessWidget {
  const _NeedsYouRow({required this.icon, required this.label, required this.onTap});

  final IconData icon;
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(10),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 10),
        child: Row(
          children: [
            Icon(icon, size: 20, color: Theme.of(context).colorScheme.onSurface.withOpacity(0.7)),
            const SizedBox(width: 10),
            Expanded(child: Text(label, style: Theme.of(context).textTheme.bodyLarge)),
            Icon(Icons.chevron_right_rounded,
                color: Theme.of(context).colorScheme.onSurface.withOpacity(0.3)),
          ],
        ),
      ),
    );
  }
}

class _FamilySummaryCard extends StatelessWidget {
  const _FamilySummaryCard({
    required this.childrenCount,
    required this.devicesCount,
    required this.alertsCount,
    required this.t,
  });

  final int childrenCount;
  final int devicesCount;
  final int alertsCount;
  final String Function(String, {int? count, Map<String, Object>? options}) t;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [AppTheme.guardian950, AppTheme.guardian950.withOpacity(0.85)],
        ),
        borderRadius: BorderRadius.circular(18),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            t('dashboard.familySummary'),
            style: Theme.of(context).textTheme.titleMedium?.copyWith(color: Colors.white),
          ),
          const SizedBox(height: 18),
          Row(
            children: [
              _StatTile(icon: Icons.child_care_rounded, value: '$childrenCount', label: t('dashboard.children', count: childrenCount)),
              _StatDivider(),
              _StatTile(icon: Icons.smartphone_rounded, value: '$devicesCount', label: t('dashboard.devices', options: {'count': devicesCount})),
              _StatDivider(),
              _StatTile(
                icon: Icons.notifications_active_rounded,
                value: '$alertsCount',
                label: t('dashboard.alerts', options: {'count': alertsCount}),
                accent: alertsCount > 0 ? AppTheme.amber500 : null,
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _StatTile extends StatelessWidget {
  const _StatTile({required this.icon, required this.value, required this.label, this.accent});

  final IconData icon;
  final String value;
  final String label;
  final Color? accent;

  @override
  Widget build(BuildContext context) {
    final color = accent ?? Colors.white;
    return Expanded(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, color: color, size: 20),
          const SizedBox(height: 8),
          Text(value, style: Theme.of(context).textTheme.headlineMedium?.copyWith(color: color)),
          Text(label, style: Theme.of(context).textTheme.bodyMedium?.copyWith(color: Colors.white70)),
        ],
      ),
    );
  }
}

class _StatDivider extends StatelessWidget {
  const _StatDivider();

  @override
  Widget build(BuildContext context) {
    return Container(width: 1, height: 44, color: Colors.white.withOpacity(0.15), margin: const EdgeInsets.symmetric(horizontal: 8));
  }
}

class _ChildCard extends StatelessWidget {
  const _ChildCard({required this.child, required this.devices, required this.t});

  final dynamic child;
  final List<dynamic> devices;
  final String Function(String, {int? count, Map<String, Object>? options}) t;

  @override
  Widget build(BuildContext context) {
    final childDevice = devices.cast<Map<String, dynamic>?>().firstWhere(
          (d) => d?['childId'] == child['id'],
          orElse: () => null,
        );
    final isOnline = childDevice != null && childDevice['lastSeenAt'] != null;
    final riskLevel = childDevice?['riskLevel'] as String?;
    final firstName = child['firstName'] as String? ?? '';

    return Card(
      child: InkWell(
        borderRadius: BorderRadius.circular(14),
        onTap: () => _showChildActions(context, child, t),
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Row(
            children: [
              Container(
                width: 48,
                height: 48,
                decoration: BoxDecoration(
                  gradient: LinearGradient(colors: [AppTheme.sage500, AppTheme.guardian950]),
                  shape: BoxShape.circle,
                ),
                alignment: Alignment.center,
                child: Text(
                  firstName.isNotEmpty ? firstName.characters.first : '?',
                  style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w700, fontSize: 18),
                ),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(firstName, style: Theme.of(context).textTheme.titleMedium),
                    const SizedBox(height: 4),
                    Row(
                      children: [
                        Container(
                          width: 8,
                          height: 8,
                          decoration: BoxDecoration(
                            color: isOnline ? AppTheme.sage500 : Colors.grey.shade400,
                            shape: BoxShape.circle,
                          ),
                        ),
                        const SizedBox(width: 6),
                        Text(isOnline ? t('dashboard.online') : t('dashboard.offline'), style: Theme.of(context).textTheme.bodyMedium),
                      ],
                    ),
                  ],
                ),
              ),
              if (childDevice != null) _RiskChip(riskLevel: riskLevel, t: t),
              const SizedBox(width: 4),
              Icon(Icons.chevron_right_rounded, color: Theme.of(context).colorScheme.onSurface.withOpacity(0.3)),
            ],
          ),
        ),
      ),
    );
  }

  void _showChildActions(BuildContext context, dynamic child, String Function(String, {int? count, Map<String, Object>? options}) t) {
    final childId = child['id'] as String;
    final childName = child['firstName'] as String? ?? '';
    final familyId = child['familyId'] as String?;
    showModalBottomSheet(
      context: context,
      builder: (sheetContext) => SafeArea(
        child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            // F1 — the child page, which is what `abny://child/<childId>` now
            // opens. It leads the sheet because it is the one entry that
            // ANSWERS «who is this», and because the three screens it hosts
            // (progress, coach, screen-time) are the ones no link can name a
            // child for.
            ListTile(
              leading: const Icon(Icons.person_outline_rounded),
              title: Text(t('childActions.childPage')),
              onTap: () {
                Navigator.of(sheetContext).pop();
                Navigator.of(context).push(
                  MaterialPageRoute(builder: (_) => ChildDetailScreen(childId: childId)),
                );
              },
            ),
            const Divider(height: 1),
            // B6 — GROWTH FIRST. The two goal entries lead this sheet
            // deliberately: the product's thesis is that a parent opens this
            // app to set and reward a goal, and only then to look at a
            // monitoring surface.
            ListTile(
              leading: const Icon(Icons.flag_outlined),
              title: Text(t('goalsHub.childGoals')),
              onTap: () {
                Navigator.of(sheetContext).pop();
                Navigator.of(context).push(
                  MaterialPageRoute(
                    builder: (_) => ProgramsListScreen(childId: childId, childName: childName),
                  ),
                );
              },
            ),
            ListTile(
              leading: const Icon(Icons.emoji_events_outlined),
              title: Text(t('goalsHub.childRewards')),
              onTap: () {
                Navigator.of(sheetContext).pop();
                Navigator.of(context).push(
                  MaterialPageRoute(
                    builder: (_) => ChildRewardsScreen(childId: childId, childName: childName),
                  ),
                );
              },
            ),
            ListTile(
              leading: const Icon(Icons.lightbulb_outline_rounded),
              title: Text(t('suggestions.title')),
              onTap: () {
                Navigator.of(sheetContext).pop();
                Navigator.of(context).push(
                  MaterialPageRoute(
                    builder: (_) => SuggestionsScreen(childId: childId, childName: childName),
                  ),
                );
              },
            ),
            const Divider(height: 1),
            ListTile(
              leading: const Icon(Icons.auto_awesome_outlined),
              title: Text(t('digitalTwin.title')),
              onTap: () {
                Navigator.of(sheetContext).pop();
                Navigator.of(context).push(
                  MaterialPageRoute(builder: (_) => DigitalTwinScreen(childId: childId, childName: childName)),
                );
              },
            ),
            ListTile(
              leading: const Icon(Icons.timeline_outlined),
              title: Text(t('lifeTimeline.title')),
              onTap: () {
                Navigator.of(sheetContext).pop();
                Navigator.of(context).push(
                  MaterialPageRoute(builder: (_) => LifeTimelineScreen(childId: childId, childName: childName)),
                );
              },
            ),
            ListTile(
              leading: const Icon(Icons.checklist_outlined),
              title: Text(t('habitTracker.title')),
              onTap: () {
                Navigator.of(sheetContext).pop();
                Navigator.of(context).push(
                  MaterialPageRoute(builder: (_) => HabitTrackerScreen(childId: childId, childName: childName)),
                );
              },
            ),
            ListTile(
              leading: const Icon(Icons.favorite_outline),
              title: Text(t('healthTrend.title')),
              onTap: () {
                Navigator.of(sheetContext).pop();
                Navigator.of(context).push(
                  MaterialPageRoute(builder: (_) => HealthTrendScreen(childId: childId, childName: childName)),
                );
              },
            ),
            ListTile(
              leading: const Icon(Icons.menu_book_outlined),
              title: Text(t('learningProgress.title')),
              onTap: () {
                Navigator.of(sheetContext).pop();
                Navigator.of(context).push(
                  MaterialPageRoute(builder: (_) => LearningProgressScreen(childId: childId, childName: childName)),
                );
              },
            ),
            ListTile(
              leading: const Icon(Icons.mosque_outlined),
              title: Text(t('faithProgress.title')),
              onTap: () {
                Navigator.of(sheetContext).pop();
                Navigator.of(context).push(
                  MaterialPageRoute(builder: (_) => FaithProgressScreen(childId: childId, childName: childName)),
                );
              },
            ),
            ListTile(
              leading: const Icon(Icons.psychology_outlined),
              title: Text(t('coaching.title')),
              onTap: () {
                Navigator.of(sheetContext).pop();
                Navigator.of(context).push(
                  MaterialPageRoute(builder: (_) => CoachingScreen(childId: childId, childName: childName)),
                );
              },
            ),
            ListTile(
              leading: const Icon(Icons.smartphone_outlined),
              title: Text(t('wellbeing.title')),
              onTap: () {
                Navigator.of(sheetContext).pop();
                Navigator.of(context).push(
                  MaterialPageRoute(builder: (_) => WellbeingScreen(childId: childId, childName: childName)),
                );
              },
            ),
            if (familyId != null)
              ListTile(
                leading: const Icon(Icons.storefront_outlined),
                title: Text(t('familyStore.title')),
                onTap: () {
                  Navigator.of(sheetContext).pop();
                  Navigator.of(context).push(
                    MaterialPageRoute(builder: (_) => FamilyStoreScreen(familyId: familyId)),
                  );
                },
              ),
            ListTile(
              leading: const Icon(Icons.qr_code_2_rounded),
              title: Text(t('dashboard.pairDevice')),
              onTap: () {
                Navigator.of(sheetContext).pop();
                Navigator.of(context).pushNamed(AppRoutes.addChild);
              },
            ),
          ],
        ),
        ),
      ),
    );
  }
}

/// PHASE E (§6) — this chip IS the answer to «هل ابني بخير اليوم؟», and it
/// used to render the backend's raw enum.
///
/// `Text(riskLevel ?? 'UNKNOWN')` put `HIGH` / `CRITICAL` / `UNKNOWN` on the
/// parent's home screen: hardcoded, untranslated, in Latin letters, inside an
/// Arabic-first product — on the single most important word on the screen. A
/// parent seeing «CRITICAL» learns a severity code, not whether their child is
/// all right, and a parent seeing «UNKNOWN» is told nothing at all when the
/// honest statement is "no data arrived from this device today".
///
/// The enum values are unchanged and still come from the backend; only their
/// PRESENTATION moved into the localization engine, phrased as answers rather
/// than as levels. An unrecognised value falls back to the same key as
/// `null` rather than leaking whatever string the server sent.
class _RiskChip extends StatelessWidget {
  const _RiskChip({required this.riskLevel, required this.t});
  final String? riskLevel;
  final String Function(String, {int? count, Map<String, Object>? options}) t;

  static const _known = {'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'};

  Color _colorFor(String? level) {
    switch (level) {
      case 'HIGH':
      case 'CRITICAL':
        return AppTheme.brick500;
      case 'MEDIUM':
        return AppTheme.amber500;
      case 'LOW':
        return AppTheme.sage500;
      default:
        return Colors.grey;
    }
  }

  @override
  Widget build(BuildContext context) {
    final color = _colorFor(riskLevel);
    final key = _known.contains(riskLevel) ? riskLevel! : 'UNKNOWN';
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      decoration: BoxDecoration(color: color.withOpacity(0.14), borderRadius: BorderRadius.circular(20)),
      child: Text(
        t('riskLevel.$key'),
        style: Theme.of(context).textTheme.bodyMedium?.copyWith(color: color, fontWeight: FontWeight.w600),
      ),
    );
  }
}

class _FirstChildEmptyState extends StatelessWidget {
  const _FirstChildEmptyState({required this.t});

  final String Function(String, {int? count, Map<String, Object>? options}) t;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(28),
      decoration: BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [AppTheme.sage500.withOpacity(0.10), AppTheme.guardian950.withOpacity(0.05)],
        ),
        borderRadius: BorderRadius.circular(20),
      ),
      child: Column(
        children: [
          Icon(Icons.family_restroom_rounded, size: 48, color: AppTheme.sage500),
          const SizedBox(height: 16),
          Text(t('dashboard.firstChildTitle'), style: Theme.of(context).textTheme.titleLarge, textAlign: TextAlign.center),
          const SizedBox(height: 8),
          Text(t('dashboard.firstChildBody'), style: Theme.of(context).textTheme.bodyMedium, textAlign: TextAlign.center),
          const SizedBox(height: 20),
          FilledButton.icon(
            onPressed: () => Navigator.of(context).pushNamed(AppRoutes.createChild),
            icon: const Icon(Icons.add_rounded),
            label: Text(t('dashboard.addFirstChild')),
          ),
        ],
      ),
    );
  }
}

class _QuickActions extends ConsumerWidget {
  const _QuickActions({required this.t});

  final String Function(String, {int? count, Map<String, Object>? options}) t;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Wrap(
      spacing: 8,
      runSpacing: 8,
      children: [
        FilledButton.icon(
          onPressed: () => Navigator.of(context).pushNamed(AppRoutes.createChild),
          icon: const Icon(Icons.add),
          label: Text(t('dashboard.addChild')),
        ),
        // F1 — the safety & protection surface. A screen reachable only from a
        // notification is a screen a parent cannot go and LOOK at, which is
        // exactly what somebody does the day after an alert.
        OutlinedButton.icon(
          onPressed: () => Navigator.of(context).pushNamed(AppRoutes.safety),
          icon: const Icon(Icons.shield_outlined),
          label: Text(t('dashboard.openSafety')),
        ),
        OutlinedButton.icon(
          onPressed: null, // Reports (Sprint 8, backend-real) — mobile screen not built this sprint
          icon: const Icon(Icons.insert_chart_outlined),
          label: Text(t('dashboard.viewReports')),
        ),
        TextButton(
          onPressed: () async {
            await ref.read(authControllerProvider.notifier).logout();
            if (context.mounted) {
              Navigator.of(context).pushNamedAndRemoveUntil(AppRoutes.login, (route) => false);
            }
          },
          child: Text(t('settings.logout')),
        ),
      ],
    );
  }
}


/// B6 — THE PRODUCT'S FRONT DOOR ON THE PARENT SIDE.
///
/// Before this card, the F4 Smart Reward Engine had no entry point in any
/// app: 23 live endpoints, zero consumers (audit PA-M-001, ⛔ Critical).
/// Everything the parent does in the flagship journey starts here —
/// create a goal, review what a child submitted, hand over a reward.
///
/// It is placed directly under the family summary, ABOVE the per-child
/// monitoring cards, because that ordering is the product's thesis:
/// growth first, monitoring second.
class _GoalsHubCard extends StatelessWidget {
  const _GoalsHubCard({required this.t, required this.pendingReviews});

  final String Function(String, {int? count, Map<String, Object>? options}) t;
  final int pendingReviews;

  @override
  Widget build(BuildContext context) {
    return DsCard(
      accent: DsColor.accent,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(t('goalsHub.title'), style: DsText.sectionTitle(context)),
          DsSpace.gapXs,
          Text(t('goalsHub.subtitle'), style: DsText.caption(context)),
          DsSpace.gapLg,
          DsPrimaryButton(
            label: t('goalsHub.openGoals'),
            icon: Icons.flag_outlined,
            onPressed: () => Navigator.of(context).pushNamed(AppRoutes.goals),
          ),
          DsSpace.gapMd,
          DsSecondaryButton(
            label: pendingReviews > 0
                ? t('goalsHub.reviewQueueWithCount', options: {'count': pendingReviews})
                : t('goalsHub.reviewQueue'),
            icon: Icons.fact_check_outlined,
            onPressed: () => Navigator.of(context).pushNamed(AppRoutes.goalReviewQueue),
          ),
          DsSpace.gapMd,
          DsSecondaryButton(
            label: t('goalsHub.fulfilments'),
            icon: Icons.redeem_outlined,
            onPressed: () => Navigator.of(context).pushNamed(AppRoutes.fulfilments),
          ),
        ],
      ),
    );
  }
}
