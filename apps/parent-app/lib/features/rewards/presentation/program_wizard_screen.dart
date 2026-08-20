import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design_system/design_system.dart';
import '../../../core/di/providers.dart';
import '../../../core/errors/api_failure.dart';
import '../../../core/localization/locale_controller.dart';
import '../application/program_draft_controller.dart';
import '../domain/program_catalogue.dart';
import '../domain/program_draft.dart';
import '../domain/reward_program.dart';

/// THE FLAGSHIP SCREEN — «حفظ سورة الملك، الآيات ١–٥، ٢٠ دقيقة، ٢٠ نقطة».
///
/// Nine steps, each one question. The brief's hard requirement is that a
/// parent can compose this goal "without touching anything that looks like
/// configuration", so every step below is a list of tappable choices or one
/// number — there is no JSON, no code, no `targetSpec` and no
/// `verificationLevel` visible anywhere on screen. The machine vocabulary
/// exists only in `ProgramDraft.toCreateBody()`.
///
/// NO BUSINESS LOGIC IN THIS FILE. Every decision this screen appears to
/// make is either (a) reading a list the server sent, or (b) calling a
/// method on [ProgramWizardController]. The local form checks live in
/// [ProgramDraft] and every one of them is re-run server-side.
class ProgramWizardScreen extends ConsumerStatefulWidget {
  const ProgramWizardScreen({super.key, this.initialChildId, this.initialChildName});

  final String? initialChildId;
  final String? initialChildName;

  @override
  ConsumerState<ProgramWizardScreen> createState() => _ProgramWizardScreenState();
}

class _ProgramWizardScreenState extends ConsumerState<ProgramWizardScreen> {
  final _surahQuery = TextEditingController();

  @override
  void initState() {
    super.initState();
    if (widget.initialChildId != null) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        ref.read(programWizardControllerProvider.notifier).setChild(
              childId: widget.initialChildId,
              childName: widget.initialChildName,
            );
      });
    }
  }

  @override
  void dispose() {
    _surahQuery.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    ref.watch(localeControllerProvider);
    final locale = ref.watch(localeControllerProvider.notifier);
    final t = locale.t;
    final state = ref.watch(programWizardControllerProvider);
    final controller = ref.read(programWizardControllerProvider.notifier);
    final catalogue = ref.watch(catalogueControllerProvider);

    // A created program is the terminal state of this screen.
    ref.listen<ProgramWizardState>(programWizardControllerProvider, (previous, next) {
      if (next.submit.isSuccess && previous?.submit.isSuccess != true) {
        Navigator.of(context).pop(next.submit.created);
      }
    });

    return Scaffold(
      appBar: AppBar(
        title: Text(t('wizard.title')),
        leading: IconButton(
          // Was `Icons.arrow_back` — a fixed left arrow. "Back" points
          // toward the start of the line, which in Arabic is the right.
          icon: DsIcons.back(context),
          tooltip: t('common.back'),
          onPressed: () {
            if (state.step == WizardStep.child) {
              Navigator.of(context).pop();
            } else {
              controller.back();
            }
          },
        ),
      ),
      body: SafeArea(
        child: catalogue.when(
          loading: () => DsLoadingState(label: t('wizard.loadingCatalogue')),
          empty: () => DsEmptyState(
            title: t('wizard.catalogueEmptyTitle'),
            body: t('wizard.catalogueEmptyBody'),
            icon: Icons.category_outlined,
            actionLabel: t('common.retry'),
            onAction: () => ref.read(catalogueControllerProvider.notifier).load(),
          ),
          error: (failure) => DsErrorState(
            failure: failure,
            title: t('wizard.catalogueErrorTitle'),
            retryLabel: t('common.retry'),
            requestIdLabel: t('common.requestId'),
            arabic: locale.isRtl,
            onRetry: () => ref.read(catalogueControllerProvider.notifier).load(),
          ),
          data: (data) => _buildFlow(context, t, locale.isRtl, state, controller, data),
        ),
      ),
    );
  }

  Widget _buildFlow(
    BuildContext context,
    String Function(String, {int? count, Map<String, Object>? options}) t,
    bool isRtl,
    ProgramWizardState state,
    ProgramWizardController controller,
    ProgramCatalogue catalogue,
  ) {
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(DsSpace.lg, DsSpace.lg, DsSpace.lg, DsSpace.sm),
          child: DsStepHeader(
            label: _stepTitle(t, state.step),
            hint: _stepHint(t, state.step),
            step: state.stepNumber,
            totalSteps: state.totalSteps,
          ),
        ),
        Expanded(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(DsSpace.lg, DsSpace.sm, DsSpace.lg, DsSpace.xxl),
            children: [_stepBody(context, t, isRtl, state, controller, catalogue)],
          ),
        ),
        _buildFooter(context, t, isRtl, state, controller),
      ],
    );
  }

  Widget _buildFooter(
    BuildContext context,
    String Function(String, {int? count, Map<String, Object>? options}) t,
    bool isRtl,
    ProgramWizardState state,
    ProgramWizardController controller,
  ) {
    final isReview = state.step == WizardStep.review;
    final blockedKey = _blockingProblemKey(state);
    return Container(
      padding: const EdgeInsets.all(DsSpace.lg),
      decoration: BoxDecoration(
        color: DsColor.surface,
        border: Border(top: BorderSide(color: DsColor.hairline)),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (blockedKey != null) ...[
            Text(
              t(blockedKey),
              style: DsText.caption(context).copyWith(color: DsColor.stateError),
              textAlign: TextAlign.center,
            ),
            DsSpace.gapSm,
          ],
          if (isReview)
            DsPrimaryButton(
              label: t('wizard.save'),
              icon: Icons.check_rounded,
              busy: state.submit.busy,
              onPressed: state.draft.isSubmittable ? controller.submit : null,
            )
          else
            DsPrimaryButton(
              label: t('wizard.next'),
              onPressed: blockedKey == null ? controller.next : null,
            ),
        ],
      ),
    );
  }

  /// The problem that blocks THIS step only — a parent on step 2 must not be
  /// told about a reward amount they have not reached yet.
  String? _blockingProblemKey(ProgramWizardState state) {
    final draft = state.draft;
    switch (state.step) {
      case WizardStep.child:
        return null;
      case WizardStep.category:
        return draft.category == null ? 'wizard.error.categoryRequired' : null;
      case WizardStep.activity:
        return draft.activity == null ? 'wizard.error.activityRequired' : null;
      case WizardStep.target:
        return draft.targetProblemKey;
      case WizardStep.duration:
        return draft.durationProblemKey;
      case WizardStep.verification:
        return draft.verificationProblemKey;
      case WizardStep.reward:
        return draft.rewardProblemKey;
      case WizardStep.rules:
        return draft.rulesProblemKey;
      case WizardStep.review:
        return draft.firstProblemKey;
    }
    // Unreachable: the switch above covers every `WizardStep`. Present only
    // because this repository has never once run `dart analyze`
    // (audit PA-M-014), so exhaustiveness here is asserted by reading, not
    // by a tool — and a missing tail return is a hard compile error.
    // ignore: dead_code
    return null;
  }

  String _stepTitle(
    String Function(String, {int? count, Map<String, Object>? options}) t,
    WizardStep step,
  ) {
    switch (step) {
      case WizardStep.child:
        return t('wizard.step.child');
      case WizardStep.category:
        return t('wizard.step.category');
      case WizardStep.activity:
        return t('wizard.step.activity');
      case WizardStep.target:
        return t('wizard.step.target');
      case WizardStep.duration:
        return t('wizard.step.duration');
      case WizardStep.verification:
        return t('wizard.step.verification');
      case WizardStep.reward:
        return t('wizard.step.reward');
      case WizardStep.rules:
        return t('wizard.step.rules');
      case WizardStep.review:
        return t('wizard.step.review');
    }
    // ignore: dead_code
    return '';
  }

  String? _stepHint(
    String Function(String, {int? count, Map<String, Object>? options}) t,
    WizardStep step,
  ) {
    switch (step) {
      case WizardStep.child:
        return t('wizard.hint.child');
      case WizardStep.verification:
        return t('wizard.hint.verification');
      case WizardStep.reward:
        return t('wizard.hint.reward');
      case WizardStep.rules:
        return t('wizard.hint.rules');
      default:
        return null;
    }
  }

  Widget _stepBody(
    BuildContext context,
    String Function(String, {int? count, Map<String, Object>? options}) t,
    bool isRtl,
    ProgramWizardState state,
    ProgramWizardController controller,
    ProgramCatalogue catalogue,
  ) {
    switch (state.step) {
      case WizardStep.child:
        return _childStep(context, t, isRtl, state, controller);
      case WizardStep.category:
        return Column(
          children: [
            for (final category in catalogue.categories)
              DsChoiceTile(
                title: category.labelAr,
                selected: state.draft.category?.code == category.code,
                onTap: () => controller.setCategory(category),
              ),
          ],
        );
      case WizardStep.activity:
        final activities = state.draft.category?.activities ?? const <ProgramActivity>[];
        if (activities.isEmpty) {
          return DsEmptyState(
            title: t('wizard.noActivitiesTitle'),
            body: t('wizard.noActivitiesBody'),
            icon: Icons.list_alt_outlined,
          );
        }
        return Column(
          children: [
            for (final activity in activities)
              DsChoiceTile(
                title: activity.labelAr,
                selected: state.draft.activity?.code == activity.code,
                onTap: () => controller.setActivity(activity),
              ),
          ],
        );
      case WizardStep.target:
        return _targetStep(context, t, isRtl, state, controller);
      case WizardStep.duration:
        return _durationStep(context, t, state, controller);
      case WizardStep.verification:
        return _verificationStep(context, t, state, controller, catalogue);
      case WizardStep.reward:
        return _rewardStep(context, t, state, controller, catalogue);
      case WizardStep.rules:
        return _rulesStep(context, t, state, controller);
      case WizardStep.review:
        return _reviewStep(context, t, isRtl, state);
    }
    // ignore: dead_code
    return const SizedBox.shrink();
  }

  // --- step 0: which child -------------------------------------------------

  Widget _childStep(
    BuildContext context,
    String Function(String, {int? count, Map<String, Object>? options}) t,
    bool isRtl,
    ProgramWizardState state,
    ProgramWizardController controller,
  ) {
    final children = ref.watch(familyChildrenProvider);
    return children.when(
      loading: () => DsLoadingState(label: t('common.loading')),
      error: (error, _) => DsErrorState(
        failure: _asFailure(error),
        title: t('wizard.childrenErrorTitle'),
        retryLabel: t('common.retry'),
        arabic: isRtl,
        onRetry: () => ref.invalidate(familyChildrenProvider),
      ),
      data: (rows) => Column(
        children: [
          // NULL childId is a real, meaningful value server-side: "every
          // child in this family". It is offered first because a family-wide
          // habit is the commonest goal.
          DsChoiceTile(
            title: t('wizard.allChildren'),
            subtitle: t('wizard.allChildrenHint'),
            selected: state.draft.childId == null,
            onTap: () => controller.setChild(childId: null),
          ),
          for (final row in rows.whereType<Map<String, dynamic>>())
            DsChoiceTile(
              title: _childName(row),
              selected: state.draft.childId == row['id']?.toString(),
              onTap: () => controller.setChild(
                childId: row['id']?.toString(),
                childName: _childName(row),
              ),
            ),
        ],
      ),
    );
  }

  String _childName(Map<String, dynamic> row) {
    final first = row['firstName']?.toString() ?? '';
    final last = row['lastName']?.toString() ?? '';
    final name = '$first $last'.trim();
    return name.isEmpty ? (row['id']?.toString() ?? '') : name;
  }

  // --- step 3: the target --------------------------------------------------

  Widget _targetStep(
    BuildContext context,
    String Function(String, {int? count, Map<String, Object>? options}) t,
    bool isRtl,
    ProgramWizardState state,
    ProgramWizardController controller,
  ) {
    final activity = state.draft.activity;
    if (activity == null) {
      return DsEmptyState(title: t('wizard.noActivitiesTitle'), icon: Icons.list_alt_outlined);
    }
    if (activity.isQuranJuz) return _juzPicker(context, t, state, controller);
    if (activity.isQuran) return _surahPicker(context, t, isRtl, state, controller, activity);
    return _genericTarget(context, t, state, controller);
  }

  Widget _juzPicker(
    BuildContext context,
    String Function(String, {int? count, Map<String, Object>? options}) t,
    ProgramWizardState state,
    ProgramWizardController controller,
  ) {
    return Wrap(
      spacing: DsSpace.sm,
      runSpacing: DsSpace.sm,
      children: [
        for (var juz = 1; juz <= ProgramLimits.juzCount; juz++)
          ChoiceChip(
            label: Text(t('wizard.juzNumber', options: {'number': juz})),
            selected: state.draft.juzNumber == juz,
            onSelected: (_) => controller.setJuz(juz),
          ),
      ],
    );
  }

  Widget _surahPicker(
    BuildContext context,
    String Function(String, {int? count, Map<String, Object>? options}) t,
    bool isRtl,
    ProgramWizardState state,
    ProgramWizardController controller,
    ProgramActivity activity,
  ) {
    final surahs = ref.watch(surahControllerProvider);
    // Idempotent — only the first call fetches.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      ref.read(surahControllerProvider.notifier).ensureLoaded();
    });

    final selected = state.draft.surah;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (selected != null) ...[
          DsCard(
            accent: DsColor.accent,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  t('wizard.selectedSurah', options: {'name': selected.nameAr}),
                  style: DsText.cardTitle(context),
                ),
                DsSpace.gapXs,
                Text(
                  t('wizard.surahAyahCount', options: {'count': selected.ayahCount}),
                  style: DsText.caption(context),
                ),
              ],
            ),
          ),
          if (!activity.isQuranSurahOnly) ...[
            _ayahRangeFields(context, t, state, controller, activity, selected),
            DsSpace.gapLg,
          ],
          _reviewAndRepetitions(context, t, state, controller),
          const Divider(height: DsSpace.xxl),
        ],
        TextField(
          controller: _surahQuery,
          onChanged: (_) => setState(() {}),
          decoration: InputDecoration(
            hintText: t('wizard.searchSurah'),
            prefixIcon: const Icon(Icons.search_rounded),
          ),
        ),
        DsSpace.gapMd,
        surahs.when(
          loading: () => DsLoadingState(label: t('wizard.loadingSurahs')),
          empty: () => DsEmptyState(
            title: t('wizard.surahsEmptyTitle'),
            icon: Icons.menu_book_outlined,
            actionLabel: t('common.retry'),
            onAction: () => ref.read(surahControllerProvider.notifier).reload(),
          ),
          error: (failure) => DsErrorState(
            failure: failure,
            title: t('wizard.surahsErrorTitle'),
            retryLabel: t('common.retry'),
            arabic: isRtl,
            compact: true,
            onRetry: () => ref.read(surahControllerProvider.notifier).reload(),
          ),
          data: (all) {
            final filtered = all.where((s) => s.matches(_surahQuery.text)).toList();
            if (filtered.isEmpty) {
              return DsEmptyState(
                title: t('wizard.noSurahMatch'),
                icon: Icons.search_off_rounded,
              );
            }
            return Column(
              children: [
                for (final surah in filtered.take(40))
                  DsChoiceTile(
                    title: t('wizard.surahRow', options: {
                      'number': surah.number,
                      'name': surah.nameAr,
                    }),
                    subtitle: t('wizard.surahAyahCount', options: {'count': surah.ayahCount}),
                    selected: selected?.number == surah.number,
                    onTap: () => controller.setSurah(surah),
                  ),
                if (filtered.length > 40)
                  Padding(
                    padding: const EdgeInsets.only(top: DsSpace.sm),
                    child: Text(
                      t('wizard.moreSurahs', options: {'count': filtered.length - 40}),
                      style: DsText.caption(context),
                    ),
                  ),
              ],
            );
          },
        ),
      ],
    );
  }

  Widget _ayahRangeFields(
    BuildContext context,
    String Function(String, {int? count, Map<String, Object>? options}) t,
    ProgramWizardState state,
    ProgramWizardController controller,
    ProgramActivity activity,
    QuranSurah surah,
  ) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        DsSpace.gapMd,
        Text(
          activity.isSingleAyah ? t('wizard.singleAyahLabel') : t('wizard.ayahRangeLabel'),
          style: DsText.cardTitle(context),
        ),
        DsSpace.gapSm,
        Row(
          children: [
            Expanded(
              child: _NumberField(
                label: activity.isSingleAyah ? t('wizard.ayah') : t('wizard.fromAyah'),
                value: state.draft.fromAyah,
                min: 1,
                max: surah.ayahCount,
                onChanged: (value) => controller.setAyahRange(fromAyah: value),
              ),
            ),
            if (!activity.isSingleAyah) ...[
              DsSpace.hGapMd,
              Expanded(
                child: _NumberField(
                  label: t('wizard.toAyah'),
                  value: state.draft.toAyah,
                  min: 1,
                  max: surah.ayahCount,
                  onChanged: (value) => controller.setAyahRange(toAyah: value),
                ),
              ),
            ],
          ],
        ),
      ],
    );
  }

  Widget _reviewAndRepetitions(
    BuildContext context,
    String Function(String, {int? count, Map<String, Object>? options}) t,
    ProgramWizardState state,
    ProgramWizardController controller,
  ) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SwitchListTile.adaptive(
          contentPadding: EdgeInsets.zero,
          value: state.draft.isReview,
          onChanged: controller.setIsReview,
          title: Text(t('wizard.isReview'), style: DsText.cardTitle(context)),
          subtitle: Text(t('wizard.isReviewHint'), style: DsText.caption(context)),
        ),
        _NumberField(
          label: t('wizard.repetitions'),
          value: state.draft.repetitions,
          min: 1,
          max: 100,
          onChanged: controller.setRepetitions,
        ),
      ],
    );
  }

  Widget _genericTarget(
    BuildContext context,
    String Function(String, {int? count, Map<String, Object>? options}) t,
    ProgramWizardState state,
    ProgramWizardController controller,
  ) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _NumberField(
          label: t('wizard.quantity'),
          value: state.draft.quantity,
          min: 1,
          max: 10000,
          onChanged: (value) => controller.setGenericTarget(quantity: value),
        ),
        DsSpace.gapMd,
        TextField(
          decoration: InputDecoration(labelText: t('wizard.unit')),
          onChanged: (value) => controller.setGenericTarget(unit: value),
        ),
        DsSpace.gapMd,
        TextField(
          decoration: InputDecoration(labelText: t('wizard.reference')),
          onChanged: (value) => controller.setGenericTarget(reference: value),
        ),
      ],
    );
  }

  // --- step 4: duration ----------------------------------------------------

  Widget _durationStep(
    BuildContext context,
    String Function(String, {int? count, Map<String, Object>? options}) t,
    ProgramWizardState state,
    ProgramWizardController controller,
  ) {
    const presets = [10, 15, 20, 30, 45, 60];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Wrap(
          spacing: DsSpace.sm,
          runSpacing: DsSpace.sm,
          children: [
            for (final minutes in presets)
              ChoiceChip(
                label: Text(t('common.minutesValue', options: {'count': minutes})),
                selected: state.draft.durationMinutes == minutes,
                onSelected: (_) => controller.setDuration(minutes),
              ),
          ],
        ),
        DsSpace.gapLg,
        _NumberField(
          label: t('wizard.customDuration'),
          value: state.draft.durationMinutes,
          min: ProgramLimits.minDurationMinutes,
          max: ProgramLimits.maxDurationMinutes,
          onChanged: (value) => controller.setDuration(value ?? state.draft.durationMinutes),
        ),
      ],
    );
  }

  // --- step 5: verification ------------------------------------------------

  Widget _verificationStep(
    BuildContext context,
    String Function(String, {int? count, Map<String, Object>? options}) t,
    ProgramWizardState state,
    ProgramWizardController controller,
    ProgramCatalogue catalogue,
  ) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (final level in catalogue.verificationLevels)
          DsChoiceTile(
            title: level.labelAr,
            // THE SERVER'S OWN RATIONALE, shown verbatim. F4 wrote a real
            // explanation for each of the nine methods; hiding it would make
            // this step a guess.
            subtitle: level.rationaleAr,
            badge: t('verification.strength.${level.strength}'),
            selected: state.draft.verification?.code == level.code,
            onTap: () => controller.setVerification(level),
          ),
        if (state.draft.verification?.needsPassScore == true) ...[
          DsSpace.gapLg,
          _NumberField(
            label: t('wizard.passScore'),
            value: state.draft.passScorePercent,
            min: 1,
            max: 100,
            onChanged: controller.setPassScore,
          ),
        ],
      ],
    );
  }

  // --- step 6: reward ------------------------------------------------------

  Widget _rewardStep(
    BuildContext context,
    String Function(String, {int? count, Map<String, Object>? options}) t,
    ProgramWizardState state,
    ProgramWizardController controller,
    ProgramCatalogue catalogue,
  ) {
    final spec = state.draft.buildRewardSpec();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (final type in catalogue.rewardTypes)
          DsChoiceTile(
            title: t('rewardType.$type'),
            subtitle: t('rewardType.$type.hint'),
            selected: state.draft.rewardType == type,
            onTap: () => controller.setRewardType(type),
          ),
        DsSpace.gapLg,
        _NumberField(
          label: spec.isScreenTime ? t('wizard.rewardMinutes') : t('wizard.rewardAmount'),
          value: state.draft.rewardAmount,
          min: 1,
          max: spec.isScreenTime ? ProgramLimits.maxScreenTimeGrantMinutes : 100000,
          onChanged: (value) => controller.setRewardAmount(value ?? state.draft.rewardAmount),
        ),
        if (spec.isScreenTime) ...[
          DsSpace.gapMd,
          _NumberField(
            label: t('wizard.screenTimeTtl'),
            value: state.draft.screenTimeExpiresInHours,
            min: 1,
            max: ProgramLimits.maxScreenTimeTtlHours,
            onChanged: controller.setScreenTimeTtl,
          ),
          DsSpace.gapSm,
          Text(t('wizard.screenTimeNote'), style: DsText.caption(context)),
        ],
        if (!spec.isPoints) ...[
          DsSpace.gapMd,
          TextField(
            decoration: InputDecoration(labelText: t('wizard.rewardDescription')),
            onChanged: controller.setRewardDescription,
          ),
        ],
        if (spec.entersFulfilmentQueue) ...[
          DsSpace.gapMd,
          Text(t('wizard.fulfilmentNote'), style: DsText.caption(context)),
        ],
      ],
    );
  }

  // --- step 7: rules -------------------------------------------------------

  Widget _rulesStep(
    BuildContext context,
    String Function(String, {int? count, Map<String, Object>? options}) t,
    ProgramWizardState state,
    ProgramWizardController controller,
  ) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(t('wizard.frequency'), style: DsText.cardTitle(context)),
        DsSpace.gapSm,
        Wrap(
          spacing: DsSpace.sm,
          children: [
            for (final frequency in ProgramFrequencies.all)
              ChoiceChip(
                label: Text(t('frequency.$frequency')),
                selected: state.draft.frequency == frequency,
                onSelected: (_) => controller.setFrequency(frequency),
              ),
          ],
        ),
        DsSpace.gapLg,
        _NumberField(
          label: t('wizard.maxPerDay'),
          value: state.draft.maxPerDay,
          min: 1,
          max: ProgramLimits.maxPerDayCeiling,
          onChanged: (value) => controller.setMaxPerDay(value ?? state.draft.maxPerDay),
        ),
        DsSpace.gapMd,
        _NumberField(
          label: t('wizard.maxPerWeek'),
          value: state.draft.maxPerWeek,
          min: 1,
          max: ProgramLimits.maxPerWeekCeiling,
          onChanged: (value) => controller.setMaxPerWeek(value ?? state.draft.maxPerWeek),
        ),
        DsSpace.gapMd,
        _NumberField(
          label: t('wizard.minAge'),
          value: state.draft.minAge,
          min: 0,
          max: ProgramLimits.maxMinAge,
          onChanged: controller.setMinAge,
        ),
        DsSpace.gapLg,
        Text(t('wizard.difficulty'), style: DsText.cardTitle(context)),
        DsSpace.gapSm,
        Wrap(
          spacing: DsSpace.sm,
          children: [
            for (final difficulty in ProgramDifficulties.all)
              ChoiceChip(
                label: Text(t('difficulty.$difficulty')),
                selected: state.draft.difficulty == difficulty,
                onSelected: (_) => controller.setDifficulty(difficulty),
              ),
          ],
        ),
        DsSpace.gapLg,
        SwitchListTile.adaptive(
          contentPadding: EdgeInsets.zero,
          value: state.draft.requiresParentApproval,
          onChanged: controller.setRequiresParentApproval,
          title: Text(t('wizard.requiresApproval'), style: DsText.cardTitle(context)),
          subtitle: Text(t('wizard.requiresApprovalHint'), style: DsText.caption(context)),
        ),
      ],
    );
  }

  // --- step 8: review ------------------------------------------------------

  Widget _reviewStep(
    BuildContext context,
    String Function(String, {int? count, Map<String, Object>? options}) t,
    bool isRtl,
    ProgramWizardState state,
  ) {
    final draft = state.draft;
    final spec = draft.buildRewardSpec();
    final failure = state.submit.failure;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (failure != null) ...[
          DsErrorState(
            failure: failure,
            title: t('wizard.saveFailedTitle'),
            retryLabel: t('common.dismiss'),
            requestIdLabel: t('common.requestId'),
            arabic: isRtl,
            compact: true,
            onRetry: () => ref.read(programWizardControllerProvider.notifier).clearSubmitFailure(),
          ),
          DsSpace.gapLg,
        ],
        DsCard(
          accent: DsColor.accent,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              DsKeyValueRow(
                label: t('wizard.review.child'),
                value: draft.childName ?? t('wizard.allChildren'),
              ),
              DsKeyValueRow(
                label: t('wizard.review.category'),
                value: draft.category?.labelAr ?? '',
              ),
              DsKeyValueRow(
                label: t('wizard.review.activity'),
                value: draft.activity?.labelAr ?? '',
              ),
              DsKeyValueRow(
                label: t('wizard.review.target'),
                value: _targetPreview(t, draft),
              ),
              DsKeyValueRow(
                label: t('wizard.review.duration'),
                value: t('common.minutesValue', options: {'count': draft.durationMinutes}),
              ),
              DsKeyValueRow(
                label: t('wizard.review.verification'),
                value: draft.verification?.labelAr ?? '',
              ),
              DsKeyValueRow(
                label: t('wizard.review.reward'),
                value: '${t('rewardType.${spec.type}')} · ${spec.amount}',
              ),
              DsKeyValueRow(
                label: t('wizard.review.rules'),
                value: t('wizard.review.rulesValue', options: {
                  'frequency': t('frequency.${draft.frequency}'),
                  'perDay': draft.maxPerDay,
                  'perWeek': draft.maxPerWeek,
                }),
              ),
            ],
          ),
        ),
        DsSpace.gapMd,
        Text(t('wizard.review.serverNote'), style: DsText.caption(context)),
      ],
    );
  }

  String _targetPreview(
    String Function(String, {int? count, Map<String, Object>? options}) t,
    ProgramDraft draft,
  ) {
    final activity = draft.activity;
    final surah = draft.surah;
    if (activity == null) return '';
    if (activity.isQuranJuz) {
      return draft.juzNumber == null
          ? ''
          : t('wizard.juzNumber', options: {'number': draft.juzNumber!});
    }
    if (activity.isQuran && surah != null) {
      if (activity.isQuranSurahOnly) {
        return t('wizard.preview.surah', options: {'name': surah.nameAr});
      }
      final from = draft.fromAyah;
      if (from == null) return t('wizard.preview.surah', options: {'name': surah.nameAr});
      final to = activity.isSingleAyah ? from : (draft.toAyah ?? from);
      return from == to
          ? t('wizard.preview.singleAyah', options: {'name': surah.nameAr, 'ayah': from})
          : t('wizard.preview.ayahRange',
              options: {'name': surah.nameAr, 'from': from, 'to': to});
    }
    final quantity = draft.quantity;
    if (quantity == null) return '';
    return '$quantity ${draft.unit ?? ''}'.trim();
  }
}

class _NumberField extends StatefulWidget {
  const _NumberField({
    required this.label,
    required this.value,
    required this.min,
    required this.max,
    required this.onChanged,
  });

  final String label;
  final int? value;
  final int min;
  final int max;
  final ValueChanged<int?> onChanged;

  @override
  State<_NumberField> createState() => _NumberFieldState();
}

class _NumberFieldState extends State<_NumberField> {
  late final TextEditingController _controller =
      TextEditingController(text: widget.value?.toString() ?? '');

  @override
  void didUpdateWidget(covariant _NumberField oldWidget) {
    super.didUpdateWidget(oldWidget);
    // Only overwrite when the CONTROLLER's own parsed value differs, so a
    // clamp applied upstream (e.g. picking a shorter surah) reaches the
    // field without fighting the user's cursor on every keystroke.
    final incoming = widget.value?.toString() ?? '';
    if (int.tryParse(_controller.text) != widget.value && _controller.text != incoming) {
      _controller.text = incoming;
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return TextField(
      controller: _controller,
      keyboardType: TextInputType.number,
      // ALWAYS LTR, even in an RTL layout: a number typed right-to-left is
      // a real, reproducible Arabic-app bug, and the field label stays RTL
      // because it lives outside this Directionality.
      textDirection: TextDirection.ltr,
      decoration: InputDecoration(
        labelText: widget.label,
        helperText: '${widget.min}–${widget.max}',
      ),
      onChanged: (text) {
        final parsed = int.tryParse(text.trim());
        widget.onChanged(parsed);
      },
    );
  }
}

/// `familyChildrenProvider` is a plain `FutureProvider` over the existing
/// `DashboardApi`, so its error arrives as a raw `Object` (an
/// `ApiException`) rather than the `ApiFailure` every repository-backed
/// controller on this screen produces. This bridges that one seam — and
/// `ApiFailure.from` already knows how to read the B3 envelope out of an
/// `ApiException`, so `messageAr` survives the crossing.
ApiFailure _asFailure(Object error) => ApiFailure.from(error);
