import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design_system/design_system.dart';
import '../../../core/di/providers.dart';
import '../../../core/localization/locale_controller.dart';
import '../../../core/widgets/sparky_mascot.dart';
import '../application/coach_controller.dart';
import '../domain/coach_models.dart';

/// «مدرّبي» — THE CHILD'S COACH TAB.
///
/// CLOSES A REAL GAP: `/api/v1/self/coach/*` shipped complete — four guarded
/// routes, an age-banded human-written content library, a safety filter on
/// every line, and a distress-escalation path — and had **no client at all**.
/// Child MVP capability 13 («التحدث مع AI Assistant») was a backend that
/// nothing called. This screen is that client.
///
/// WHAT THIS SCREEN IS NOT, AND WHY THAT IS THE DESIGN:
/// it is not a chat. There is no message list, no bubbles, no composer that
/// sends arbitrary text and renders a generated reply. The child reads
/// today's card, taps one of nine questions and reads the answer written for
/// their age band, and — separately — has one place to say how they feel,
/// which is a safety path and not a conversation. The server enforces all of
/// this at the route layer; this file simply does not build the surface that
/// would need enforcing.
///
/// ARABIC: every sentence the child reads about themselves
/// (`messageAr`, `questionAr`, `answerAr`, the safety card) is server-authored
/// and rendered VERBATIM — it has already passed the safety engine at the
/// child's own band. Only the chrome is localized through `t(...)`.
class CoachScreen extends ConsumerWidget {
  const CoachScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    ref.watch(localeControllerProvider);
    final locale = ref.watch(localeControllerProvider.notifier);
    final t = locale.t;
    final state = ref.watch(coachControllerProvider);
    final controller = ref.read(coachControllerProvider.notifier);

    return RefreshIndicator(
      onRefresh: controller.load,
      child: KidStateView<CoachHome>(
        state: state.home,
        arabic: locale.isRtl,
        loadingLabel: t('coach.loading'),
        emptyTitle: t('coach.emptyTitle'),
        emptyBody: t('coach.emptyBody'),
        errorTitle: t('coach.errorTitle'),
        retryLabel: t('common.retry'),
        onRetry: controller.load,
        emptyActionLabel: t('common.retry'),
        onEmptyAction: controller.load,
        builder: (context, home) {
          return ListView(
            padding: KidSpace.screen,
            children: [
              _TodayCard(encouragement: home.encouragement),
              KidSpace.gapLg,

              // THE SAFETY CARD OUTRANKS EVERYTHING ELSE ON THE SCREEN.
              // When it is present it is rendered directly under the card the
              // child was already reading, before the questions, so it cannot
              // be missed below a fold.
              if (state.safetyCard != null) ...[
                _SafetyCard(
                  card: state.safetyCard!,
                  onDismiss: controller.dismissSafetyCard,
                ),
                KidSpace.gapLg,
              ],

              const _CheckinField(),
              KidSpace.gapLg,

              if (home.topics.isNotEmpty) ...[
                KidSectionHeader(
                  title: t('coach.questionsTitle'),
                  subtitle: t('coach.questionsSubtitle'),
                ),
                for (final topic in home.topics)
                  _TopicTile(
                    topic: topic,
                    isOpen: state.openTopicCode == topic.code,
                    isLoading: state.answerLoadingCode == topic.code,
                    answer: state.answers[topic.code],
                    failureText: state.openTopicCode == topic.code
                        ? state.answerFailure?.displayFor(arabic: locale.isRtl)
                        : null,
                    onTap: () => controller.openTopic(topic.code),
                  ),
              ],
            ],
          );
        },
      ),
    );
  }
}

/// Today's encouragement.
///
/// The intent drives ONLY the mascot's mood. A child is never shown the word
/// `RESTART` — that is a label for the fact that they broke a streak, and
/// naming it back to them is exactly the diagnosis this product does not do.
class _TodayCard extends ConsumerWidget {
  const _TodayCard({required this.encouragement});

  final ChildEncouragement encouragement;

  SparkyMood get _mood {
    switch (encouragement.intent) {
      case CoachIntent.celebrate:
        return SparkyMood.celebrating;
      case CoachIntent.rest:
        return SparkyMood.happy;
      case CoachIntent.nudge:
      case CoachIntent.restart:
      case CoachIntent.unknown:
        return SparkyMood.neutral;
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = ref.watch(localeControllerProvider.notifier).t;
    if (encouragement.isEmpty) return const SizedBox.shrink();

    return KidCard(
      accent: KidColor.magic,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SparkyMascot(mood: _mood, size: 64),
          KidSpace.hGapMd,
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(t('coach.todayTitle'), style: KidText.caption(context)),
                KidSpace.gapXs,
                // SERVER-AUTHORED. Rendered verbatim, never through `t(...)`.
                Text(encouragement.messageAr, style: KidText.cardTitle(context)),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// «كيف تشعر اليوم؟» — the only free-text field a child has anywhere in this
/// product.
///
/// Stateful purely to own the [TextEditingController]; the send is delegated.
/// The 500-character ceiling matches `ChildCheckinDto`'s `@Length(1, 500)`,
/// so the child meets a counter rather than a rejected request.
class _CheckinField extends ConsumerStatefulWidget {
  const _CheckinField();

  @override
  ConsumerState<_CheckinField> createState() => _CheckinFieldState();
}

class _CheckinFieldState extends ConsumerState<_CheckinField> {
  final TextEditingController _text = TextEditingController();
  bool _hasText = false;

  @override
  void initState() {
    super.initState();
    _text.addListener(_onChanged);
  }

  void _onChanged() {
    final has = _text.text.trim().isNotEmpty;
    if (has != _hasText) setState(() => _hasText = has);
  }

  @override
  void dispose() {
    _text.removeListener(_onChanged);
    _text.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    final value = _text.text;
    // Cleared BEFORE the await, not after: the field must not still be
    // holding what the child wrote while a safety card is on screen.
    _text.clear();
    FocusScope.of(context).unfocus();
    await ref.read(coachControllerProvider.notifier).submitCheckin(value);
  }

  @override
  Widget build(BuildContext context) {
    final locale = ref.watch(localeControllerProvider.notifier);
    final t = locale.t;
    final state = ref.watch(coachControllerProvider);

    return KidCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(t('coach.checkinTitle'), style: KidText.sectionTitle(context)),
          KidSpace.gapXs,
          Text(t('coach.checkinHint'), style: KidText.caption(context)),
          KidSpace.gapMd,
          TextField(
            controller: _text,
            maxLines: 3,
            minLines: 2,
            maxLength: CoachController.checkinMaxLength,
            textInputAction: TextInputAction.newline,
            enabled: !state.checkinSubmitting,
            inputFormatters: [
              LengthLimitingTextInputFormatter(CoachController.checkinMaxLength),
            ],
            decoration: InputDecoration(
              hintText: t('coach.checkinPlaceholder'),
              border: OutlineInputBorder(borderRadius: KidRadius.controlBorder),
            ),
          ),
          KidSpace.gapSm,
          KidBigButton(
            label: t('coach.checkinSend'),
            icon: Icons.favorite_rounded,
            color: KidColor.magic,
            busy: state.checkinSubmitting,
            onPressed: _hasText ? _send : null,
          ),
          if (state.checkinFailure != null) ...[
            KidSpace.gapSm,
            Text(
              state.checkinFailure!.displayFor(arabic: locale.isRtl),
              style: KidText.caption(context),
            ),
          ],
        ],
      ),
    );
  }
}

/// THE SAFETY CARD.
///
/// One fixed, human-written response, identical for every distress code, so
/// the card never tells a child how serious the classifier judged their words
/// to be. Every sentence and every helpline here comes from the server; this
/// widget adds no text of its own beyond the two button labels.
///
/// The numbers are `SelectableText` with a copy action rather than tap-to-dial
/// links: dialling needs `url_launcher`, which this app does not depend on,
/// and a dependency that cannot be resolved or built in this environment is
/// not something to add on the safety path of all places.
class _SafetyCard extends ConsumerWidget {
  const _SafetyCard({required this.card, required this.onDismiss});

  final DistressCard card;
  final VoidCallback onDismiss;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final t = ref.watch(localeControllerProvider.notifier).t;

    return KidCard(
      accent: KidColor.warm,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(Icons.volunteer_activism_rounded, color: KidColor.warm),
              KidSpace.hGapSm,
              Expanded(
                child: Text(card.titleAr, style: KidText.sectionTitle(context)),
              ),
            ],
          ),
          KidSpace.gapSm,
          Text(card.bodyAr, style: KidText.body(context)),
          if (card.helplines.isNotEmpty) ...[
            KidSpace.gapMd,
            for (final line in card.helplines)
              Padding(
                padding: const EdgeInsets.only(bottom: KidSpace.sm),
                child: Row(
                  children: [
                    Expanded(child: Text(line.labelAr, style: KidText.body(context))),
                    KidSpace.hGapSm,
                    SelectableText(
                      line.number,
                      // The number is a number in every locale. Forcing LTR
                      // stops an RTL paragraph from reordering its digits.
                      textDirection: TextDirection.ltr,
                      style: KidText.cardTitle(context),
                    ),
                    IconButton(
                      icon: const Icon(Icons.copy_rounded, size: 20),
                      tooltip: t('coach.copyNumber'),
                      onPressed: () {
                        Clipboard.setData(ClipboardData(text: line.number));
                        ScaffoldMessenger.of(context).showSnackBar(
                          SnackBar(content: Text(t('coach.numberCopied'))),
                        );
                      },
                    ),
                  ],
                ),
              ),
          ],
          KidSpace.gapSm,
          KidQuietButton(label: t('coach.safetyDismiss'), onPressed: onDismiss),
        ],
      ),
    );
  }
}

/// One question from the closed vocabulary, and its answer inline.
///
/// The child taps a QUESTION, not a text field. `topic.code` is never shown —
/// it exists only to be sent back to the route that validates it against the
/// nine-value enum.
class _TopicTile extends ConsumerWidget {
  const _TopicTile({
    required this.topic,
    required this.isOpen,
    required this.isLoading,
    required this.answer,
    required this.failureText,
    required this.onTap,
  });

  final CoachTopic topic;
  final bool isOpen;
  final bool isLoading;
  final CoachAnswer? answer;
  final String? failureText;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return KidCard(
      onTap: onTap,
      accent: isOpen ? KidColor.primary : null,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                // SERVER-AUTHORED question text.
                child: Text(topic.questionAr, style: KidText.cardTitle(context)),
              ),
              KidSpace.hGapSm,
              Icon(
                isOpen ? Icons.expand_less_rounded : Icons.expand_more_rounded,
                color: KidColor.mutedInk,
              ),
            ],
          ),
          if (isOpen) ...[
            KidSpace.gapMd,
            if (isLoading)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: KidSpace.sm),
                child: SizedBox(
                  height: 22,
                  width: 22,
                  child: CircularProgressIndicator(strokeWidth: 2.5),
                ),
              )
            else if (failureText != null)
              // A refused or failed answer is rendered as a plain sentence in
              // the child's own language — no error icon, no red. The server's
              // own `messageAr` is the sentence whenever it sent one.
              Text(failureText!, style: KidText.body(context))
            else if (answer != null)
              // SERVER-AUTHORED answer, at this child's age band.
              Text(answer!.answerAr, style: KidText.body(context)),
          ],
        ],
      ),
    );
  }
}
