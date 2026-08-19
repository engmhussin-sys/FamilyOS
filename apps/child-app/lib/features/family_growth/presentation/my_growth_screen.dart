import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design_system/design_system.dart';
import '../../../core/di/providers.dart';
import '../../../core/errors/api_failure.dart';
import '../../../core/localization/locale_controller.dart';
import '../../../core/routing/child_deep_link_router.dart';
import '../../../core/routing/deep_link.dart';
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
  List<dynamic>? _coachingTips;
  List<dynamic>? _smartTasks;
  String _childName = 'there'; // honest default only until the real profile loads

  /// THE B3 ENVELOPE, not `e.toString()`. This used to hold raw exception
  /// text — which the error widget then did not render, so the child was
  /// told a fixed «ياااه! حاجة ما حمّلتش.» while the server had already
  /// written the actual reason in Arabic and it was thrown away.
  ApiFailure? _failure;

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
    setState(() => _failure = null);
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
      // CLOSES A REAL GAP: acknowledgeMessage existed in the backend
      // since an earlier sprint but had zero Child App caller —
      // every delivered message stayed "new" forever from the
      // backend's own perspective. Fire-and-forget (not awaited
      // sequentially) — never worth delaying this screen's render on.
      for (final m in _messages ?? []) {
        final message = m as Map<String, dynamic>;
        if (message['acknowledgedAt'] == null) {
          unawaited(api.acknowledgeMessage(message['id'] as String));
        }
      }
    } catch (e) {
      if (mounted) setState(() => _failure = ApiFailure.from(e));
      return;
    }

    // Sprint 16.4 — CLOSES A REAL GAP: fetched SEPARATELY with its own
    // try/catch, same "one section's failure never blocks another"
    // discipline as WellbeingScreen's own insight-fetch pattern —
    // Health/Learning being unavailable must never block the
    // already-working Habits/Faith/Messages sections above.
    // THE COMMENT ABOVE WAS TRUE OF THE INTENT AND FALSE OF THE CODE.
    //
    // These five calls used to share ONE `Future.wait` and ONE `catch`, which
    // is the opposite of "one section's failure never blocks another":
    // `Future.wait` rejects on the FIRST error, so a single failing call
    // discarded the four that had already succeeded and the whole block fell
    // into a silent `catch (_)`.
    //
    // That was not hypothetical. `generateSmartTasks()` threw a `TypeError`
    // on EVERY call (it cast an array response to a Map — see that method's
    // own note), so in practice health, learning, rewards and coaching never
    // rendered either. Fixing the cast alone would have hidden how much this
    // basket was costing; each call now settles on its own.
    final api = ref.read(familyGrowthApiProvider);
    final results = await Future.wait<Object?>([
      _softly(api.getHealthProgress),
      _softly(api.getLearningProgress),
      _softly(api.getRewardsAccount),
      _softly(api.getCoaching),
      _softly(api.generateSmartTasks),
    ]);
    if (!mounted) return;
    setState(() {
      // `as ... ?` not `as ...`: a null means that ONE section is unavailable
      // and renders its own empty state. It never means the others are.
      _healthProgress = results[0] as Map<String, dynamic>?;
      _learningProgress = results[1] as Map<String, dynamic>?;
      _rewardsAccount = results[2] as Map<String, dynamic>?;
      _coachingTips = results[3] as List<dynamic>?;
      _smartTasks = results[4] as List<dynamic>?;
    });
  }

  /// Runs one section's fetch and converts its failure into `null` instead of
  /// letting it take the other four with it. Deliberately catch-all: these are
  /// supplementary sections on a screen that has already rendered, and there
  /// is no version of "the rewards balance failed" that should blank the
  /// child's habits.
  Future<T?> _softly<T>(Future<T> Function() call) async {
    try {
      return await call();
    } catch (_) {
      return null;
    }
  }

  void _celebrate(String message, Color color) {
    if (!mounted) return;
    CelebrationOverlay.of(context).burst();
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Row(
          children: [
            const Icon(Icons.celebration_rounded, size: KidSize.iconSm, color: KidColor.onColour),
            const SizedBox(width: KidSpace.sm),
            Expanded(child: Text(message, style: KidText.onColour(context).copyWith(fontWeight: FontWeight.w600))),
          ],
        ),
        backgroundColor: color,
        behavior: SnackBarBehavior.floating,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(KidRadius.control)),
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

  /// CLOSES A REAL GAP: the missing UI consumer for SmartTaskEngineService
  /// (context-aware suggestions, now server-computed after fixing a
  /// real backend design flaw). ACCEPTED is a real commitment
  /// distinct from COMPLETED — the child says "yes I'll do this," not
  /// "I already did." DISMISSED simply removes it from view; the
  /// child is never forced to act on a suggestion.
  Future<void> _decideSmartTask(String taskId, String status) async {
    try {
      await ref.read(familyGrowthApiProvider).decideSmartTask(taskId, status);
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
            icon: const Icon(Icons.water_drop_rounded, size: KidSize.iconSm),
            label: Text(t('myGrowth.logWater')),
          ),
          body: _failure != null
              ? _buildFriendlyError(t, localeController.isRtl)
              : (_habits == null || _practices == null || _messages == null)
                  ? Center(child: KidLoadingState(label: t('common.loading')))
                  : RefreshIndicator(
                      color: KidTheme.skyBlue,
                      onRefresh: _loadAll,
                      child: ListView(
                        padding: const EdgeInsetsDirectional.fromSTEB(KidSpace.lg, KidSpace.sm, KidSpace.lg, 96),
                        children: [
                          Row(
                            crossAxisAlignment: CrossAxisAlignment.center,
                            children: [
                              Expanded(
                                child: DailyProgressRing(
                                  completed: _completedToday,
                                  total: _totalTasks,
                                  // The ring used to hold these five
                                  // sentences as English literals. They are
                                  // resolved here, where `t` lives.
                                  greeting: _totalTasks > 0 && _completedToday >= _totalTasks
                                      ? t('myGrowth.ringGreetingAllDone', options: {'name': _childName})
                                      : t('myGrowth.ringGreeting', options: {'name': _childName}),
                                  encouragement: _totalTasks > 0 && _completedToday >= _totalTasks
                                      ? t('myGrowth.ringAllDone')
                                      : _totalTasks > 0
                                          ? t('myGrowth.ringKeepGoing')
                                          : t('myGrowth.ringNothingYet'),
                                  allDoneSemanticLabel: t('myGrowth.ringAllDoneLabel'),
                                ),
                              ),
                            ],
                          ),
                          const SizedBox(height: KidSpace.sm),
                          Align(
                            alignment: Alignment.center,
                            child: SparkyMascot(
                              mood: _totalTasks > 0 && _completedToday >= _totalTasks
                                  ? SparkyMood.celebrating
                                  : SparkyMood.happy,
                              size: 64,
                            ),
                          ),
                          const SizedBox(height: KidSpace.lg),
                          // Sprint 16.4 — CLOSES A REAL GAP: a compact coins/XP
                          // summary, real data only (never rendered if
                          // _rewardsAccount hasn't loaded — no placeholder numbers).
                          if (_rewardsAccount != null) ...[
                            _RewardsSummaryChip(account: _rewardsAccount!, t: t),
                            const SizedBox(height: KidSpace.lg),
                          ],
                          // Sprint 16.4 continuation — CLOSES A REAL GAP: Coaching
                          // had zero Child App representation before this.
                          // Best-effort — absent entirely if unavailable, and
                          // ALSO absent when the list is empty (no tip is a
                          // valid, honest state — never a fabricated
                          // placeholder message).
                          if (_coachingTips != null && _coachingTips!.isNotEmpty) ...[
                            ..._coachingTips!.map((tip) => _CoachingTipCard(tip: tip as Map<String, dynamic>)),
                            const SizedBox(height: KidSpace.lg),
                          ],
                          // Sprint continuation — CLOSES A REAL GAP: SmartTaskEngineService
                          // had zero UI consumer. Only SUGGESTED tasks shown — an
                          // already-decided one (accepted/dismissed/completed)
                          // has nothing left to ask the child about.
                          if (_smartTasks != null && _smartTasks!.where((t) => (t as Map<String, dynamic>)['status'] == 'SUGGESTED').isNotEmpty) ...[
                            ..._smartTasks!
                                .where((t) => (t as Map<String, dynamic>)['status'] == 'SUGGESTED')
                                .map((task) => _SmartTaskCard(
                                      task: task as Map<String, dynamic>,
                                      acceptLabel: t('myGrowth.smartTaskAccept'),
                                      dismissLabel: t('myGrowth.smartTaskDismiss'),
                                      onAccept: () => _decideSmartTask(task['id'] as String, 'ACCEPTED'),
                                      onDismiss: () => _decideSmartTask(task['id'] as String, 'DISMISSED'),
                                    )),
                            const SizedBox(height: KidSpace.lg),
                          ],
                          if (_messages!.isNotEmpty) ...[
                            _SectionHeader(icon: Icons.mail_rounded, title: t('myGrowth.messages'), color: KidTheme.messagesAccent),
                            ..._messages!.map((m) => _MessageCard(message: m as Map<String, dynamic>)),
                            const SizedBox(height: KidSpace.xl),
                          ],
                          // Sprint 16.4 — CLOSES A REAL GAP: Health had zero
                          // Child App representation before this sprint's new
                          // /self/health/progress endpoint. Best-effort — the
                          // whole card is simply absent if the fetch failed,
                          // never a fake/zero placeholder.
                          if (_healthProgress != null) ...[
                            _SectionHeader(icon: Icons.favorite_rounded, title: t('myGrowth.healthTitle'), color: KidTheme.healthAccent),
                            _HealthProgressCard(progress: _healthProgress!, t: t),
                            const SizedBox(height: KidSpace.xl),
                          ],
                          // Sprint 16.4 — CLOSES A REAL GAP: Education had zero
                          // Child App representation before this sprint.
                          if (_learningProgress != null) ...[
                            _SectionHeader(icon: Icons.menu_book_rounded, title: t('myGrowth.learningTitle'), color: KidTheme.messagesAccent),
                            _LearningProgressCard(progress: _learningProgress!, t: t, onLogSession: _logStudySession),
                            const SizedBox(height: KidSpace.xl),
                          ],
                          _SectionHeader(icon: Icons.check_circle_rounded, title: t('myGrowth.myHabits'), color: KidTheme.habitsAccent),
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
                          const SizedBox(height: KidSpace.xl),
                          _SectionHeader(icon: Icons.mosque_rounded, title: t('myGrowth.faith'), color: KidTheme.faithAccent),
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

  /// The chrome line stays this screen's; the EXPLANATION is the server's.
  ///
  /// `KidErrorState` keeps Sparky and the warm framing this widget already
  /// had, and adds the one thing it was missing: `failure.displayFor(arabic:)`
  /// — the Arabic sentence the server wrote for this exact failure, which
  /// used to be discarded in favour of a fixed «ياااه! حاجة ما حمّلتش.».
  Widget _buildFriendlyError(
    String Function(String, {int? count, Map<String, Object>? options}) t,
    bool arabic,
  ) {
    return Center(
      child: SingleChildScrollView(
        child: KidErrorState(
          failure: _failure!,
          title: t('myGrowth.loadError'),
          retryLabel: t('myGrowth.tryAgain'),
          arabic: arabic,
          onRetry: _loadAll,
        ),
      ),
    );
  }
}

class _SectionHeader extends StatelessWidget {
  const _SectionHeader({required this.icon, required this.title, required this.color});

  /// WAS a `String emoji`. An emoji is drawn by whatever emoji font the
  /// device happens to ship; a Material glyph is inside the APK, renders
  /// identically on every phone in this product's market, and takes the
  /// section's own accent colour instead of its own.
  final IconData icon;
  final String title;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: KidSpace.md, top: KidSpace.xs),
      child: Row(
        children: [
          Container(
            width: 36,
            height: 36,
            decoration: BoxDecoration(color: color.withOpacity(0.18), shape: BoxShape.circle),
            alignment: Alignment.center,
            child: Icon(icon, size: KidSize.iconSm, color: color),
          ),
          const SizedBox(width: KidSpace.md),
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
      padding: const EdgeInsets.only(bottom: KidSpace.md),
      child: Text(text, style: Theme.of(context).textTheme.bodyMedium),
    );
  }
}

/// Sprint 16.4 — CLOSES A REAL GAP: a compact coins/XP summary,
/// matching the brief's own "the child should know what they've
/// earned" requirement — real numbers only, never rendered with
/// placeholder data.
/// Sprint 16.4 continuation — CLOSES A REAL GAP: displays a
/// CoachingEngineService recommendation (already server-side filtered
/// to CHILD track only — see the backend endpoint's own docstring).
/// Deterministic, encouraging text — this app never runs an LLM per
/// display, matching Architecture 1.0's own "no LLM per event" rule.
class _CoachingTipCard extends StatelessWidget {
  const _CoachingTipCard({required this.tip});
  final Map<String, dynamic> tip;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: KidSpace.md),
      padding: const EdgeInsets.all(KidSpace.md),
      decoration: BoxDecoration(
        gradient: KidGradient.tint(KidTheme.habitsAccent),
        borderRadius: BorderRadius.circular(KidRadius.control),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Icon(Icons.auto_awesome_rounded, size: KidSize.iconSm, color: KidTheme.habitsAccent),
          const SizedBox(width: KidSpace.md),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(tip['title'] as String? ?? '', style: Theme.of(context).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w700)),
                const SizedBox(height: KidSpace.xs),
                Text(tip['body'] as String? ?? '', style: Theme.of(context).textTheme.bodyMedium),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// CLOSES A REAL GAP: displays a SmartTaskEngineService suggestion
/// (server-computed context, e.g. missed sleep or low hydration —
/// see generateForTodayAuto's own docstring for exactly what's
/// used). Deterministic text — zero LLM per display.
class _SmartTaskCard extends StatelessWidget {
  const _SmartTaskCard({
    required this.task,
    required this.acceptLabel,
    required this.dismissLabel,
    required this.onAccept,
    required this.onDismiss,
  });

  final Map<String, dynamic> task;
  final String acceptLabel;
  final String dismissLabel;
  final VoidCallback onAccept;
  final VoidCallback onDismiss;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: KidSpace.md),
      padding: const EdgeInsets.all(KidSpace.md),
      decoration: BoxDecoration(
        gradient: KidGradient.tint(KidTheme.skyBlue),
        borderRadius: BorderRadius.circular(KidRadius.control),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(Icons.lightbulb_rounded, size: KidSize.iconSm, color: KidTheme.skyBlue),
              const SizedBox(width: KidSpace.sm),
              Expanded(child: Text(task['title'] as String? ?? '', style: Theme.of(context).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w700))),
            ],
          ),
          const SizedBox(height: KidSpace.md),
          Row(
            children: [
              Expanded(
                child: OutlinedButton(
                  onPressed: onDismiss,
                  child: Text(dismissLabel),
                ),
              ),
              const SizedBox(width: KidSpace.sm),
              Expanded(
                child: FilledButton(
                  onPressed: onAccept,
                  style: FilledButton.styleFrom(backgroundColor: KidTheme.skyBlue),
                  child: Text(acceptLabel),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _RewardsSummaryChip extends StatelessWidget {
  const _RewardsSummaryChip({required this.account, required this.t});
  final Map<String, dynamic> account;
  final String Function(String, {int? count, Map<String, Object>? options}) t;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(vertical: KidSpace.md, horizontal: KidSpace.lg),
      decoration: BoxDecoration(
        gradient: KidGradient.duo(KidTheme.sunshineYellow, KidTheme.coral),
        borderRadius: BorderRadius.circular(KidRadius.card),
      ),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceEvenly,
        children: [
          _rewardStat(context, Icons.monetization_on_rounded, '${account['coins'] ?? 0}', t('myGrowth.coins'), KidTheme.sunshineYellow),
          Container(width: 1, height: 32, color: KidTheme.mutedInk.withOpacity(0.2)),
          _rewardStat(context, Icons.star_rounded, '${account['xp'] ?? 0}', t('myGrowth.xp'), KidTheme.berryPurple),
          Container(width: 1, height: 32, color: KidTheme.mutedInk.withOpacity(0.2)),
          _rewardStat(context, Icons.emoji_events_rounded, '${account['level'] ?? 1}', t('myGrowth.level'), KidTheme.coral),
        ],
      ),
    );
  }

  Widget _rewardStat(BuildContext context, IconData icon, String value, String label, Color colour) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(icon, size: KidSize.iconSm, color: colour),
        KidSpace.gapXs,
        // Was `fontSize: 16, w700` and `fontSize: 11` — two sizes that are
        // on no scale in this app.
        Text(value, style: KidText.stat(context)),
        Text(label, style: KidText.caption(context)),
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

    // WAS a hand-built `Container` with its own white fill, its own radius
    // and its own shadow, holding a private `_progressRow` that drew an
    // emoji, a bar and — for "you did it" — the single character
    // U+2705. Meaning stated only in an emoji font is meaning a cheap
    // Android phone can render as a grey outline or a tofu box, and it is
    // also colour-only once the bar turns green. `KidProgressRow` states
    // it three ways: a Material glyph that ships inside the app, the
    // colour, and a localised label a screen reader can read out.
    return KidCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (hydration != null)
            KidProgressRow(
              icon: Icons.water_drop_rounded,
              label: t('myGrowth.waterLabel'),
              valueLabel: '${hydration['actualMl'] as int? ?? 0}/${hydration['targetMl'] as int? ?? 1} ${t('myGrowth.millilitresUnit')}',
              fraction: _fraction(hydration['actualMl'], hydration['targetMl']),
              achieved: hydration['isAchieved'] as bool? ?? false,
              achievedSemanticLabel: t('myGrowth.achievedLabel'),
              color: KidTheme.healthAccent,
            ),
          if (activity != null)
            KidProgressRow(
              icon: Icons.directions_run_rounded,
              label: t('myGrowth.activityLabel'),
              valueLabel: '${activity['totalMinutes'] as int? ?? 0}/${activity['targetMinutes'] as int? ?? 1} ${t('myGrowth.minutesUnit')}',
              fraction: _fraction(activity['totalMinutes'], activity['targetMinutes']),
              achieved: activity['isAchieved'] as bool? ?? false,
              achievedSemanticLabel: t('myGrowth.achievedLabel'),
              color: KidTheme.healthAccent,
            ),
        ],
      ),
    );
  }

  static double _fraction(Object? actual, Object? target) {
    final a = actual is int ? actual : 0;
    final b = target is int ? target : 0;
    return b > 0 ? (a / b) : 0;
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
      padding: const EdgeInsets.all(KidSpace.lg),
      decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(KidRadius.card), boxShadow: [
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
                  style: KidText.cardTitle(context),
                ),
                KidSpace.gapXs,
                // Was `fontSize: 12` — off the scale, and with no line
                // height, which is what clips an Arabic descender.
                Text(t('myGrowth.sessionsCount', options: {'count': totalSessions}), style: KidText.caption(context)),
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
      margin: const EdgeInsets.only(bottom: KidSpace.md),
      decoration: BoxDecoration(
        color: isDone ? color.withOpacity(0.06) : Colors.white,
        borderRadius: BorderRadius.circular(KidRadius.card),
        boxShadow: isDone
            ? null
            : [BoxShadow(color: color.withOpacity(0.12), blurRadius: 16, offset: const Offset(0, 6))],
      ),
      child: Padding(
        padding: const EdgeInsetsDirectional.fromSTEB(KidSpace.lg, KidSpace.md, KidSpace.md, KidSpace.md),
        child: Row(
          children: [
            Container(width: 6, height: 40, decoration: BoxDecoration(color: color, borderRadius: BorderRadius.circular(KidRadius.sm))),
            const SizedBox(width: KidSpace.md),
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

/// ONE MESSAGE, AND THE TAP THAT NOW LANDS SOMEWHERE.
///
/// F1 — THE IN-APP HALF OF `abny://`. This card was inert: it rendered a
/// server-authored sentence, the screen acknowledged it on load, and a tap did
/// nothing at all. The server now resolves a destination for every
/// notification it sends and delivers it under `deepLink` (see
/// `core/routing/deep_link.dart`), so a row that carries one is now openable,
/// and it opens through `ChildDeepLinkRouter` — the same resolver a future
/// push handler will call, never a second one.
///
/// AND THE ROW NOW CARRIES ONE. `/life-intelligence/self/messages` serves
/// `data` on every message — `{"deepLink": "abny://<surface>"}` — written by the
/// approval-gated child branch of the delivery pipeline and narrowed on the
/// server to that single key, so this row carries a DESTINATION and never a
/// `familyId`, a `childId`, a `deviceId` or a token. Nothing here parses it:
/// `deepLinkFromNotification` reads the one key and `ChildDeepLinkRouter`
/// decides where it lands, because a client that decided would be a second
/// opinion nobody can audit.
///
/// TAPPABLE EXACTLY WHEN THERE IS SOMEWHERE TO GO, and this is deliberate
/// rather than defensive. `data` is `null` on every message written before that
/// field existed and on every message a PARENT typed — neither names a screen —
/// and NOTHING BACKFILLS A GUESS: such a card stays exactly as inert as it
/// looks. A card that offered a tap and then did nothing, or that quietly
/// re-opened the screen the child is already on, would be the same dead end in
/// a nicer coat.
///
/// The message's own words are server-authored and rendered VERBATIM: they
/// passed the safety engine at this child's own age band, and nothing here
/// rewrites, keys or truncates them.
class _MessageCard extends ConsumerWidget {
  const _MessageCard({required this.message});
  final Map<String, dynamic> message;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // `t` IS RESOLVED HERE, and it was not resolved anywhere before this line.
    // The «جديد» badge below called `t('myGrowth.newLabel')` in a class that
    // has no `t` in scope and no enclosing one to inherit — a bare undefined
    // identifier, which is a COMPILE error, not a runtime one: this file could
    // not be built, and neither could the app. `verify_l10n_parity` reported
    // the key as resolving because the key does exist in both locales; what it
    // does not do, and does not claim to do, is type-check the call site.
    ref.watch(localeControllerProvider);
    final t = ref.watch(localeControllerProvider.notifier).t;
    final isNew = message['acknowledgedAt'] == null;
    final link = deepLinkFromNotification(message);

    return Container(
      margin: const EdgeInsets.only(bottom: KidSpace.md),
      decoration: BoxDecoration(
        gradient: KidGradient.tint(KidTheme.messagesAccent),
        borderRadius: BorderRadius.circular(KidRadius.card),
        border: isNew ? Border.all(color: KidTheme.messagesAccent, width: 1.5) : null,
      ),
      // Transparency, so the ripple draws over the gradient above instead of
      // under it.
      child: Material(
        type: MaterialType.transparency,
        child: InkWell(
          borderRadius: BorderRadius.circular(KidRadius.card),
          onTap: link == null
              ? null
              : () => ChildDeepLinkRouter.followLink(context, ref, link),
          child: Padding(
            padding: const EdgeInsets.all(KidSpace.lg),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Icon(Icons.mail_rounded, size: KidSize.iconMd, color: KidTheme.messagesAccent),
                const SizedBox(width: KidSpace.md),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Expanded(child: Text(message['title'] as String? ?? '', style: Theme.of(context).textTheme.titleMedium)),
                          // WAS an 8px coloured dot and nothing else —
                          // "this one is new" stated in hue alone, which a
                          // colour-blind child and a screen reader both miss.
                          // A badge says it in words.
                          if (isNew) ...[
                            KidSpace.hGapSm,
                            KidBadge(label: t('myGrowth.newLabel'), color: KidTheme.messagesAccent),
                          ],
                        ],
                      ),
                      const SizedBox(height: KidSpace.xs),
                      Text(message['body'] as String? ?? '', style: Theme.of(context).textTheme.bodyLarge),
                    ],
                  ),
                ),
                // The one affordance, and only when the tap leads somewhere.
                // The hand-written `isRtl ? ... : ...` mirror is now a token,
                // so every chevron in the app answers to one rule.
                if (link != null)
                  KidIcons.disclosure(context, color: KidTheme.messagesAccent),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
