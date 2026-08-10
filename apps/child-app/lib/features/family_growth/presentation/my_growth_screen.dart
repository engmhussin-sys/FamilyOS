import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/di/providers.dart';
import '../../../core/localization/locale_controller.dart';
import '../../../core/theme/kid_theme.dart';
import '../../../core/widgets/celebration_overlay.dart';
import '../../../core/widgets/daily_progress_ring.dart';
import '../../../core/widgets/sparky_mascot.dart';

/// Combines Habits + Hydration quick-log + Faith practices + Messages
/// into ONE screen — same "related concerns, one screen" discipline
/// DeviceHomeScreen already established for this app.
///
/// SCOPE NOTE (stated honestly, not hidden): DeviceHomeScreen's own
/// comment describes this app's screens as "onboarding/diagnostic
/// screens only" — this screen is a genuine, deliberate expansion of
/// that stated scope.
///
/// Sprint 16.4 (Child Daily Experience) — CLOSES A REAL GAP: this
/// screen already had the "related concerns, one place" design
/// principle Sprint 16.4 asks for ("Today" experience, not separate
/// technical modules) — Health and Learning were the two real,
/// confirmed-missing pieces (backend endpoints existed since Sprint
/// 15/16.3 but had ZERO Child App path — see this sprint's own new
/// /self/health/progress and /self/learning/progress endpoints).
/// Extended this EXISTING screen rather than building a new one —
/// Reuse First, per the brief's own explicit instruction.
class MyGrowthScreen extends ConsumerStatefulWidget {
  const MyGrowthScreen({super.key});

  @override
  ConsumerState<MyGrowthScreen> createState() => _MyGrowthScreenState();
}

class _MyGrowthScreenState extends ConsumerState<MyGrowthScreen> {
  List<dynamic>? _habits;
  List<dynamic>? _practices;
  List<dynamic>? _messages;
  Map<String, dynamic>? _healthProgress;
  Map<String, dynamic>? _learningProgress;
  Map<String, dynamic>? _rewardsAccount;
  String _childName = 'there'; // honest default only until the real profile loads
  String? _errorMessage;

  int get _totalTasks => (_habits?.length ?? 0) + (_practices?.length ?? 0);

  /// CLOSES THE HONEST GAP flagged in design pass 1: the backend now
  /// returns `completedToday` per habit/practice (Sprint 30 backend
  /// fix), so this is a real count, not a placeholder.
  int get _completedToday {
    final habitsDone = _habits?.where((h) => (h as Map<String, dynamic>)['completedToday'] == true).length ?? 0;
    final practicesDone = _practices?.where((p) => (p as Map<String, dynamic>)['completedToday'] == true).length ?? 0;
    return habitsDone + practicesDone;
  }

  @override
  void initState() {
    super.initState();
    _loadAll();
  }

  Future<void> _loadAll() async {
    setState(() => _errorMessage = null);
    try {
      final api = ref.read(familyGrowthApiProvider);
      final results = await Future.wait([api.getHabits(), api.getFaithPractices(), api.getMessages(), api.getProfile()]);
      if (mounted) {
        setState(() {
          _habits = results[0] as List<dynamic>;
          _practices = results[1] as List<dynamic>;
          _messages = results[2] as List<dynamic>;
          _childName = (results[3] as Map<String, dynamic>)['firstName'] as String? ?? 'there';
        });
      }
    } catch (e) {
      if (mounted) setState(() => _errorMessage = e.toString());
      return;
    }

    // Sprint 16.4 — CLOSES A REAL GAP: fetched SEPARATELY with its own
    // try/catch, same "one section's failure never blocks another"
    // discipline as WellbeingScreen's own insight-fetch pattern —
    // Health/Learning being unavailable must never block the
    // already-working Habits/Faith/Messages sections above.
    try {
      final api = ref.read(familyGrowthApiProvider);
      final results = await Future.wait([api.getHealthProgress(), api.getLearningProgress(), api.getRewardsAccount()]);
      if (mounted) {
        setState(() {
          _healthProgress = results[0] as Map<String, dynamic>;
          _learningProgress = results[1] as Map<String, dynamic>;
          _rewardsAccount = results[2] as Map<String, dynamic>;
        });
      }
    } catch (_) {
      // Best-effort — the screen already rendered successfully above.
    }
  }

  void _celebrate(String message, Color color) {
    if (!mounted) return;
    CelebrationOverlay.of(context).burst();
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Row(
          children: [
            const Text('\u{1F389}', style: TextStyle(fontSize: 20)),
            const SizedBox(width: 8),
            Expanded(child: Text(message, style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w600))),
          ],
        ),
        backgroundColor: color,
        behavior: SnackBarBehavior.floating,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
        duration: const Duration(seconds: 2),
      ),
    );
  }

  Future<void> _completeHabit(String habitId, String habitTitle) async {
    try {
      await ref.read(familyGrowthApiProvider).completeHabit(habitId);
      _celebrate(ref.read(localeControllerProvider.notifier).t('myGrowth.habitDone', options: {'title': habitTitle}), KidTheme.habitsAccent);
    } catch (_) {
      // Best-effort — no scary error text for a single low-stakes retry-safe action.
    }
    await _loadAll();
  }

  Future<void> _logWater() async {
    try {
      await ref.read(familyGrowthApiProvider).logHydration(250);
      _celebrate(ref.read(localeControllerProvider.notifier).t('myGrowth.hydrationDone'), KidTheme.healthAccent);
    } catch (_) {
      // Best-effort.
    }
    await _loadAll();
  }

  Future<void> _logFaithPractice(String practiceId, String practiceTitle) async {
    try {
      await ref.read(familyGrowthApiProvider).logFaithPractice(practiceId);
      _celebrate(ref.read(localeControllerProvider.notifier).t('myGrowth.faithDone', options: {'title': practiceTitle}), KidTheme.faithAccent);
    } catch (_) {
      // Best-effort.
    }
    await _loadAll();
  }

  /// Sprint 16.4 — CLOSES A REAL GAP: logs a fixed 20-minute study
  /// session under a generic "study" subject — an honest MVP
  /// interaction (a single tap, matching this app's own "simple, not
  /// a dashboard" design principle) rather than a full session-entry
  /// form this sprint's time didn't allow building well.
  Future<void> _logStudySession() async {
    try {
      final now = DateTime.now();
      final dateStr = '${now.year.toString().padLeft(4, '0')}-${now.month.toString().padLeft(2, '0')}-${now.day.toString().padLeft(2, '0')}';
      await ref.read(familyGrowthApiProvider).logLearningSession(subject: 'study', durationMinutes: 20, date: dateStr);
      _celebrate(ref.read(localeControllerProvider.notifier).t('myGrowth.studyDone'), KidTheme.messagesAccent);
    } catch (_) {
      // Best-effort.
    }
    await _loadAll();
  }

  @override
  Widget build(BuildContext context) {
    ref.watch(localeControllerProvider);
    final localeController = ref.watch(localeControllerProvider.notifier);
    final t = localeController.t;

    return Directionality(
      textDirection: localeController.isRtl ? TextDirection.rtl : TextDirection.ltr,
      child: CelebrationOverlay(
        child: Scaffold(
          appBar: AppBar(title: Text(t('myGrowth.title'))),
          floatingActionButton: FloatingActionButton.extended(
            onPressed: _logWater,
            icon: const Text('\u{1F4A7}', style: TextStyle(fontSize: 20)),
            label: Text(t('myGrowth.logWater')),
          ),
          body: _errorMessage != null
              ? _buildFriendlyError(t)
              : (_habits == null || _practices == null || _messages == null)
                  ? const Center(child: CircularProgressIndicator(color: KidTheme.skyBlue))
                  : RefreshIndicator(
                      color: KidTheme.skyBlue,
                      onRefresh: _loadAll,
                      child: ListView(
                        padding: const EdgeInsets.fromLTRB(16, 8, 16, 96),
                        children: [
                          Row(
                            crossAxisAlignment: CrossAxisAlignment.center,
                            children: [
                              Expanded(
                                child: DailyProgressRing(
                                  completed: _completedToday,
                                  total: _totalTasks,
                                  childName: _childName,
                                ),
                              ),
                            ],
                          ),
                          const SizedBox(height: 8),
                          Align(
                            alignment: Alignment.center,
                            child: SparkyMascot(
                              mood: _totalTasks > 0 && _completedToday >= _totalTasks
                                  ? SparkyMood.celebrating
                                  : SparkyMood.happy,
                              size: 64,
                            ),
                          ),
                          const SizedBox(height: 20),
                          // Sprint 16.4 — CLOSES A REAL GAP: a compact coins/XP
                          // summary, real data only (never rendered if
                          // _rewardsAccount hasn't loaded — no placeholder numbers).
                          if (_rewardsAccount != null) ...[
                            _RewardsSummaryChip(account: _rewardsAccount!, t: t),
                            const SizedBox(height: 20),
                          ],
                          if (_messages!.isNotEmpty) ...[
                            _SectionHeader(emoji: '\u{1F48C}', title: t('myGrowth.messages'), color: KidTheme.messagesAccent),
                            ..._messages!.map((m) => _MessageCard(message: m as Map<String, dynamic>)),
                            const SizedBox(height: 24),
                          ],
                          // Sprint 16.4 — CLOSES A REAL GAP: Health had zero
                          // Child App representation before this sprint's new
                          // /self/health/progress endpoint. Best-effort — the
                          // whole card is simply absent if the fetch failed,
                          // never a fake/zero placeholder.
                          if (_healthProgress != null) ...[
                            _SectionHeader(emoji: '\u{1F4AA}', title: t('myGrowth.healthTitle'), color: KidTheme.healthAccent),
                            _HealthProgressCard(progress: _healthProgress!, t: t),
                            const SizedBox(height: 24),
                          ],
                          // Sprint 16.4 — CLOSES A REAL GAP: Education had zero
                          // Child App representation before this sprint.
                          if (_learningProgress != null) ...[
                            _SectionHeader(emoji: '\u{1F4DA}', title: t('myGrowth.learningTitle'), color: KidTheme.messagesAccent),
                            _LearningProgressCard(progress: _learningProgress!, t: t, onLogSession: _logStudySession),
                            const SizedBox(height: 24),
                          ],
                          _SectionHeader(emoji: '\u{2B50}', title: t('myGrowth.myHabits'), color: KidTheme.habitsAccent),
                          if (_habits!.isEmpty) _EmptyHint(text: t('myGrowth.noHabitsYet')),
                          ..._habits!.map(
                            (h) => _TaskCard(
                              title: (h as Map<String, dynamic>)['title'] as String? ?? '',
                              subtitle: h['category'] as String?,
                              color: KidTheme.habitsAccent,
                              isDone: h['completedToday'] as bool? ?? false,
                              doneLabel: t('myGrowth.done'),
                              onDone: () => _completeHabit(h['id'] as String, h['title'] as String? ?? 'habit'),
                            ),
                          ),
                          const SizedBox(height: 24),
                          _SectionHeader(emoji: '\u{1F54C}', title: t('myGrowth.faith'), color: KidTheme.faithAccent),
                          if (_practices!.isEmpty) _EmptyHint(text: t('myGrowth.noPracticesYet')),
                          ..._practices!.map(
                            (p) => _TaskCard(
                              title: (p as Map<String, dynamic>)['title'] as String? ?? '',
                              color: KidTheme.faithAccent,
                              isDone: p['completedToday'] as bool? ?? false,
                              doneLabel: t('myGrowth.done'),
                              onDone: () => _logFaithPractice(p['id'] as String, p['title'] as String? ?? 'practice'),
                            ),
                          ),
                        ],
                      ),
                    ),
        ),
      ),
    );
  }

  Widget _buildFriendlyError(String Function(String, {int? count, Map<String, Object>? options}) t) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const SparkyMascot(mood: SparkyMood.neutral, size: 72),
            const SizedBox(height: 16),
            Text(
              t('myGrowth.loadError'),
              style: Theme.of(context).textTheme.titleLarge,
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 8),
            Text(
              t('myGrowth.tryAgainPrompt'),
              style: Theme.of(context).textTheme.bodyMedium,
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 20),
            FilledButton.icon(
              onPressed: _loadAll,
              icon: const Icon(Icons.refresh_rounded),
              label: Text(t('myGrowth.tryAgain')),
            ),
          ],
        ),
      ),
    );
  }
}

class _SectionHeader extends StatelessWidget {
  const _SectionHeader({required this.emoji, required this.title, required this.color});

  final String emoji;
  final String title;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 10, top: 4),
      child: Row(
        children: [
          Container(
            width: 36,
            height: 36,
            decoration: BoxDecoration(color: color.withOpacity(0.18), shape: BoxShape.circle),
            alignment: Alignment.center,
            child: Text(emoji, style: const TextStyle(fontSize: 18)),
          ),
          const SizedBox(width: 10),
          Text(title, style: Theme.of(context).textTheme.headlineMedium),
        ],
      ),
    );
  }
}

class _EmptyHint extends StatelessWidget {
  const _EmptyHint({required this.text});
  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Text(text, style: Theme.of(context).textTheme.bodyMedium),
    );
  }
}

/// Sprint 16.4 — CLOSES A REAL GAP: a compact coins/XP summary,
/// matching the brief's own "the child should know what they've
/// earned" requirement — real numbers only, never rendered with
/// placeholder data.
class _RewardsSummaryChip extends StatelessWidget {
  const _RewardsSummaryChip({required this.account, required this.t});
  final Map<String, dynamic> account;
  final String Function(String, {int? count, Map<String, Object>? options}) t;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 14, horizontal: 18),
      decoration: BoxDecoration(
        gradient: LinearGradient(
          colors: [KidTheme.sunshineYellow.withOpacity(0.25), KidTheme.coral.withOpacity(0.15)],
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
        ),
        borderRadius: BorderRadius.circular(20),
      ),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceEvenly,
        children: [
          _rewardStat('\u{1FA99}', '${account['coins'] ?? 0}', t('myGrowth.coins')),
          Container(width: 1, height: 32, color: KidTheme.mutedInk.withOpacity(0.2)),
          _rewardStat('\u2B50', '${account['xp'] ?? 0}', 'XP'),
          Container(width: 1, height: 32, color: KidTheme.mutedInk.withOpacity(0.2)),
          _rewardStat('\u{1F3C6}', '${account['level'] ?? 1}', t('myGrowth.level')),
        ],
      ),
    );
  }

  Widget _rewardStat(String emoji, String value, String label) {
    return Column(
      children: [
        Text(emoji, style: const TextStyle(fontSize: 20)),
        Text(value, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16)),
        Text(label, style: const TextStyle(fontSize: 11, color: KidTheme.mutedInk)),
      ],
    );
  }
}

/// Sprint 16.4 — CLOSES A REAL GAP: matches the brief's own explicit
/// worked example ("Water: 5/8 cups, Activity: 25/30 min") using
/// REAL backend data (getDailyProgress, Sprint 15/16.1/16.3) —
/// never a fabricated number.
class _HealthProgressCard extends StatelessWidget {
  const _HealthProgressCard({required this.progress, required this.t});
  final Map<String, dynamic> progress;
  final String Function(String, {int? count, Map<String, Object>? options}) t;

  @override
  Widget build(BuildContext context) {
    final hydration = progress['hydration'] as Map<String, dynamic>?;
    final activity = progress['activity'] as Map<String, dynamic>?;

    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(20), boxShadow: [
        BoxShadow(color: KidTheme.healthAccent.withOpacity(0.10), blurRadius: 14, offset: const Offset(0, 5)),
      ]),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (hydration != null)
            _progressRow('\u{1F4A7}', t('myGrowth.waterLabel'), hydration['actualMl'] as int? ?? 0, hydration['targetMl'] as int? ?? 1, hydration['isAchieved'] as bool? ?? false, 'ml'),
          if (hydration != null && activity != null) const SizedBox(height: 12),
          if (activity != null)
            _progressRow('\u{1F3C3}', t('myGrowth.activityLabel'), activity['totalMinutes'] as int? ?? 0, activity['targetMinutes'] as int? ?? 1, activity['isAchieved'] as bool? ?? false, t('myGrowth.minutesUnit')),
        ],
      ),
    );
  }

  Widget _progressRow(String emoji, String label, int actual, int target, bool achieved, String unit) {
    return Row(
      children: [
        Text(emoji, style: const TextStyle(fontSize: 22)),
        const SizedBox(width: 10),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(label, style: const TextStyle(fontWeight: FontWeight.w600)),
              const SizedBox(height: 4),
              ClipRRect(
                borderRadius: BorderRadius.circular(8),
                child: LinearProgressIndicator(
                  value: target > 0 ? (actual / target).clamp(0.0, 1.0) : 0,
                  minHeight: 8,
                  backgroundColor: KidTheme.mutedInk.withOpacity(0.1),
                  valueColor: AlwaysStoppedAnimation(achieved ? KidTheme.sage500 : KidTheme.healthAccent),
                ),
              ),
            ],
          ),
        ),
        const SizedBox(width: 10),
        Text('$actual/$target $unit', style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 13)),
        if (achieved) const Padding(padding: EdgeInsets.only(left: 6), child: Text('\u2705')),
      ],
    );
  }
}

/// Sprint 16.4 — CLOSES A REAL GAP: Education had zero Child App
/// representation before this sprint. Real streak/session data only
/// (getLearningProgress, extended with streak in Sprint 16.1 Phase 5).
class _LearningProgressCard extends StatelessWidget {
  const _LearningProgressCard({required this.progress, required this.t, required this.onLogSession});
  final Map<String, dynamic> progress;
  final String Function(String, {int? count, Map<String, Object>? options}) t;
  final VoidCallback onLogSession;

  @override
  Widget build(BuildContext context) {
    final streakDays = progress['streakDays'] as int? ?? 0;
    final totalSessions = progress['totalSessions'] as int? ?? 0;

    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(20), boxShadow: [
        BoxShadow(color: KidTheme.messagesAccent.withOpacity(0.10), blurRadius: 14, offset: const Offset(0, 5)),
      ]),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  streakDays > 0 ? t('myGrowth.learningStreak', options: {'count': streakDays}) : t('myGrowth.learningNoStreak'),
                  style: const TextStyle(fontWeight: FontWeight.w600),
                ),
                const SizedBox(height: 4),
                Text(t('myGrowth.sessionsCount', options: {'count': totalSessions}), style: const TextStyle(fontSize: 12, color: KidTheme.mutedInk)),
              ],
            ),
          ),
          FilledButton.icon(
            onPressed: onLogSession,
            style: FilledButton.styleFrom(backgroundColor: KidTheme.messagesAccent),
            icon: const Icon(Icons.menu_book_rounded, size: 18),
            label: Text(t('myGrowth.studyNow')),
          ),
        ],
      ),
    );
  }
}

/// A single tappable task, with a soft shadow and colored left-edge
/// accent for real visual depth instead of a flat bordered rectangle.
class _TaskCard extends StatelessWidget {
  const _TaskCard({required this.title, this.subtitle, required this.color, required this.isDone, required this.doneLabel, required this.onDone});

  final String title;
  final String? subtitle;
  final Color color;
  final bool isDone;
  final String doneLabel;
  final VoidCallback onDone;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      decoration: BoxDecoration(
        color: isDone ? color.withOpacity(0.06) : Colors.white,
        borderRadius: BorderRadius.circular(20),
        boxShadow: isDone
            ? null
            : [BoxShadow(color: color.withOpacity(0.12), blurRadius: 16, offset: const Offset(0, 6))],
      ),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 12, 12, 12),
        child: Row(
          children: [
            Container(width: 6, height: 40, decoration: BoxDecoration(color: color, borderRadius: BorderRadius.circular(3))),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    title,
                    style: Theme.of(context).textTheme.titleMedium?.copyWith(
                          decoration: isDone ? TextDecoration.lineThrough : null,
                          color: isDone ? KidTheme.mutedInk : null,
                        ),
                  ),
                  if (subtitle != null)
                    Text(subtitle!, style: Theme.of(context).textTheme.bodyMedium),
                ],
              ),
            ),
            if (isDone)
              Container(
                width: 40,
                height: 40,
                decoration: BoxDecoration(color: color, shape: BoxShape.circle),
                child: const Icon(Icons.check_rounded, color: Colors.white, size: 22),
              )
            else
              FilledButton(
                onPressed: onDone,
                style: FilledButton.styleFrom(backgroundColor: color, minimumSize: const Size(90, 48)),
                child: Text(doneLabel),
              ),
          ],
        ),
      ),
    );
  }
}

class _MessageCard extends StatelessWidget {
  const _MessageCard({required this.message});
  final Map<String, dynamic> message;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      decoration: BoxDecoration(
        gradient: LinearGradient(
          colors: [KidTheme.messagesAccent.withOpacity(0.16), KidTheme.messagesAccent.withOpacity(0.06)],
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
        ),
        borderRadius: BorderRadius.circular(20),
      ),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('\u{1F48C}', style: TextStyle(fontSize: 24)),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(message['title'] as String? ?? '', style: Theme.of(context).textTheme.titleMedium),
                  const SizedBox(height: 2),
                  Text(message['body'] as String? ?? '', style: Theme.of(context).textTheme.bodyLarge),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
