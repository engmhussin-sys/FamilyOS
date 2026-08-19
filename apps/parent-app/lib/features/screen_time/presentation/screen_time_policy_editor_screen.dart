import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design_system/design_system.dart';
import '../../../core/di/providers.dart';
import '../../../core/localization/locale_controller.dart';
import '../application/screen_time_policy_editor_controller.dart';
import '../domain/screen_time_policy.dart';

/// EDIT THE POLICY — `POST /children/:childId/screen-time-policy`.
///
/// THE FORM RESPECTS `SetScreenTimePolicyDto`'S REAL BOUNDS, transcribed in
/// `ScreenTimePolicyLimits` from the DTO itself rather than guessed:
/// `dailyLimitMinutes` is `@Min(0) @Max(1440)`, both bedtimes are
/// `@Matches(/^([01]\d|2[0-3]):([0-5]\d)$/)`, `focusModeEnabled` is a boolean,
/// and every field is `@IsOptional()`. Mirroring them client-side does not
/// move the decision — the server still validates and still explains itself in
/// Arabic through the B3 envelope — it only means the common typo is answered
/// in the parent's own language instead of after a round trip.
///
/// WHAT «SAVE» ACTUALLY DOES, said out loud on the screen: `setPolicy`
/// REPLACES the active policy. The previous row is soft-deleted, not edited,
/// so a history of changes survives — and so a field left blank here is a field
/// the new row does not have. That matters for `weekdaySchedule`, which this
/// app has no editor for: if the policy being replaced carried per-weekday
/// overrides, saving drops them, and the screen warns BEFORE the save.
///
/// THE BONUS MINUTES ARE NOT IN THIS FORM, deliberately. The form is seeded
/// from the CONFIGURED policy, never the effective allowance; seeding it from
/// the effective number would bake a child's earned bonus into the base limit,
/// where it would then be counted twice — once inside the new base and once
/// again as the live grant that has not expired yet.
class ScreenTimePolicyEditorScreen extends ConsumerWidget {
  const ScreenTimePolicyEditorScreen({
    super.key,
    required this.childId,
    this.childName,
  });

  final String childId;
  final String? childName;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    ref.watch(localeControllerProvider);
    final locale = ref.watch(localeControllerProvider.notifier);
    final t = locale.t;
    final state = ref.watch(screenTimePolicyEditorControllerProvider(childId));
    final controller =
        ref.read(screenTimePolicyEditorControllerProvider(childId).notifier);

    return Scaffold(
      appBar: AppBar(
        title: Text(childName == null || childName!.isEmpty
            ? t('screenTimeEdit.title')
            : t('screenTimeEdit.titleForChild', options: {'name': childName!})),
      ),
      body: DsStateView<ScreenTimePolicy?>(
        state: state.initial,
        arabic: locale.isRtl,
        loadingLabel: t('common.loading'),
        // UNREACHABLE FROM THIS CONTROLLER — `UiState.data(null)` is how «no
        // policy yet» arrives, which is a perfectly good starting point for a
        // NEW policy, so the loader never produces `empty`. Worded anyway,
        // because `DsStateView` requires all four and a screen that fills this
        // in with a shrug is a screen that renders a blank page the day the
        // controller changes.
        emptyTitle: t('screenTimeEdit.emptyTitle'),
        emptyBody: t('screenTimeEdit.emptyBody'),
        emptyIcon: Icons.tune_rounded,
        errorTitle: t('screenTimeEdit.errorTitle'),
        retryLabel: t('common.retry'),
        requestIdLabel: t('common.requestId'),
        onRetry: controller.load,
        skeletonRows: 3,
        builder: (context, _) => _EditorForm(
          state: state,
          controller: controller,
          arabic: locale.isRtl,
        ),
      ),
    );
  }
}

class _EditorForm extends ConsumerWidget {
  const _EditorForm({
    required this.state,
    required this.controller,
    required this.arabic,
  });

  final PolicyEditorState state;
  final ScreenTimePolicyEditorController controller;
  final bool arabic;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    ref.watch(localeControllerProvider);
    final t = ref.watch(localeControllerProvider.notifier).t;

    // THE SAVE SUCCEEDED — pop with `true` so the overview re-reads BOTH of its
    // routes. Done in a post-frame callback because a `Navigator.pop` during
    // `build` is a framework error, and the state flag is what makes it happen
    // exactly once.
    if (state.saved) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        final navigator = Navigator.of(context);
        if (navigator.canPop()) navigator.pop(true);
      });
    }

    return ListView(
      padding: DsSpace.screen,
      children: [
        if (state.saveFailure != null) ...[
          // THE SERVER'S OWN SENTENCE, never a transport string and never an
          // `e.toString()`. `DsErrorState` renders `ApiFailure.display` —
          // Arabic first — plus every field error the B3 envelope carried.
          DsErrorState(
            failure: state.saveFailure!,
            title: t('screenTimeEdit.saveFailedTitle'),
            retryLabel: t('common.dismiss'),
            requestIdLabel: t('common.requestId'),
            arabic: arabic,
            compact: true,
            onRetry: controller.clearSaveFailure,
          ),
          DsSpace.gapLg,
        ],

        Text(t('screenTimeEdit.intro'), style: DsText.caption(context)),
        DsSpace.gapLg,

        DsSectionHeader(
          title: t('screenTimeEdit.dailyLimitSection'),
          subtitle: t('screenTimeEdit.dailyLimitHint'),
        ),
        _MinutesField(
          label: t('screenTimeEdit.dailyLimitLabel'),
          helper: t('screenTimeEdit.dailyLimitRange', options: {
            'min': ScreenTimePolicyLimits.minDailyLimitMinutes,
            'max': ScreenTimePolicyLimits.maxDailyLimitMinutes,
          }),
          value: state.dailyLimitText,
          onChanged: controller.setDailyLimitText,
        ),
        DsSpace.gapSm,
        Text(t('screenTimeEdit.dailyLimitBlankNote'), style: DsText.caption(context)),

        DsSpace.gapLg,
        DsSectionHeader(
          title: t('screenTimeEdit.bedtimeSection'),
          subtitle: t('screenTimeEdit.bedtimeHint'),
        ),
        _TimeField(
          label: t('screenTimeEdit.bedtimeStartLabel'),
          value: state.bedtimeStart,
          onChanged: controller.setBedtimeStart,
        ),
        DsSpace.gapMd,
        _TimeField(
          label: t('screenTimeEdit.bedtimeEndLabel'),
          value: state.bedtimeEnd,
          onChanged: controller.setBedtimeEnd,
        ),
        if (state.bedtimeIncomplete) ...[
          DsSpace.gapSm,
          // ADVISORY, NOT BLOCKING: the DTO accepts each end independently, so
          // refusing to send it would be this client inventing a rule the
          // server does not have.
          Text(
            t('screenTimeEdit.bedtimeIncompleteNote'),
            style: DsText.caption(context).copyWith(color: DsColor.warn),
          ),
        ],

        DsSpace.gapLg,
        SwitchListTile.adaptive(
          contentPadding: EdgeInsets.zero,
          value: state.focusModeEnabled,
          onChanged: controller.setFocusMode,
          title: Text(t('screenTimeEdit.focusMode'), style: DsText.cardTitle(context)),
          subtitle: Text(t('screenTimeEdit.focusModeHint'), style: DsText.caption(context)),
        ),

        if (state.hadWeekdaySchedule) ...[
          DsSpace.gapLg,
          DsCard(
            accent: DsColor.warn,
            child: Text(
              t('screenTimeEdit.weekdayScheduleWarning'),
              style: DsText.caption(context),
            ),
          ),
        ],

        if (state.problems.isNotEmpty) ...[
          DsSpace.gapLg,
          DsCard(
            accent: DsColor.stateError,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                for (final problem in state.problems)
                  Padding(
                    padding: const EdgeInsets.only(bottom: DsSpace.xs),
                    child: Text(
                      '• ${_problemMessage(t, problem)}',
                      style: DsText.caption(context).copyWith(color: DsColor.stateError),
                    ),
                  ),
              ],
            ),
          ),
        ],

        DsSpace.gapLg,
        Text(t('screenTimeEdit.replaceNote'), style: DsText.caption(context)),
        DsSpace.gapMd,
        DsPrimaryButton(
          label: t('screenTimeEdit.save'),
          icon: Icons.check_rounded,
          busy: state.busy,
          onPressed: state.isValid ? controller.save : null,
        ),
      ],
    );
  }

  /// Every [PolicyFormProblem] to a LITERAL localisation key. Literal because
  /// `verify_l10n_parity.py` only sees `t('…')` call sites written out, and a
  /// key assembled from a variable is a key nothing checks. Exhaustive over the
  /// enum, so a bound added to the DTO and mirrored in the controller cannot
  /// reach a parent as a blank bullet.
  String _problemMessage(
    String Function(String, {int? count, Map<String, Object>? options}) t,
    PolicyFormProblem problem,
  ) {
    switch (problem) {
      case PolicyFormProblem.dailyLimitOutOfRange:
        return t('screenTimeEdit.problemDailyLimitRange', options: {
          'min': ScreenTimePolicyLimits.minDailyLimitMinutes,
          'max': ScreenTimePolicyLimits.maxDailyLimitMinutes,
        });
      case PolicyFormProblem.dailyLimitNotANumber:
        return t('screenTimeEdit.problemDailyLimitNumber');
      case PolicyFormProblem.bedtimeStartFormat:
        return t('screenTimeEdit.problemBedtimeStart');
      case PolicyFormProblem.bedtimeEndFormat:
        return t('screenTimeEdit.problemBedtimeEnd');
    }
  }
}

/// A minutes field. ALWAYS LTR, even in an RTL layout: a number typed
/// right-to-left is a real, reproducible Arabic-app bug — the same reason
/// `program_wizard_screen.dart`'s `_NumberField` pins its direction.
class _MinutesField extends StatefulWidget {
  const _MinutesField({
    required this.label,
    required this.helper,
    required this.value,
    required this.onChanged,
  });

  final String label;
  final String helper;
  final String value;
  final ValueChanged<String> onChanged;

  @override
  State<_MinutesField> createState() => _MinutesFieldState();
}

class _MinutesFieldState extends State<_MinutesField> {
  late final TextEditingController _controller =
      TextEditingController(text: widget.value);

  @override
  void didUpdateWidget(covariant _MinutesField oldWidget) {
    super.didUpdateWidget(oldWidget);
    // Only when the value genuinely diverged upstream, so the cursor is never
    // yanked to the end on every keystroke.
    if (widget.value != _controller.text) _controller.text = widget.value;
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
      textDirection: TextDirection.ltr,
      decoration: InputDecoration(
        labelText: widget.label,
        helperText: widget.helper,
      ),
      onChanged: widget.onChanged,
    );
  }
}

/// An `"HH:mm"` field. LTR for the same reason as the minutes field — a clock
/// time is a number too — and hinted with the exact shape the DTO's regex
/// accepts, so the hint and the validator cannot disagree.
class _TimeField extends StatefulWidget {
  const _TimeField({
    required this.label,
    required this.value,
    required this.onChanged,
  });

  final String label;
  final String value;
  final ValueChanged<String> onChanged;

  @override
  State<_TimeField> createState() => _TimeFieldState();
}

class _TimeFieldState extends State<_TimeField> {
  late final TextEditingController _controller =
      TextEditingController(text: widget.value);

  @override
  void didUpdateWidget(covariant _TimeField oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.value != _controller.text) _controller.text = widget.value;
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
      keyboardType: TextInputType.datetime,
      textDirection: TextDirection.ltr,
      decoration: InputDecoration(
        labelText: widget.label,
        // NOT localised, and not a sentence: `21:00` is the literal shape the
        // server's regex accepts, identical in every locale.
        hintText: '21:00',
      ),
      onChanged: widget.onChanged,
    );
  }
}
