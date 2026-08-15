import 'package:flutter/material.dart';

import '../errors/api_failure.dart';
import '../state/ui_state.dart';
import '../widgets/sparky_mascot.dart';
import 'kid_components.dart';
import 'kid_tokens.dart';

/// THE FOUR STATE WIDGETS — child side.
///
/// THE DIFFERENCE FROM THE PARENT'S COPY IS THE WHOLE POINT.
/// A parent's error state is an operational report: icon, sentence,
/// requestId, retry. A child's is a person: Sparky, a warm sentence, and a
/// way forward. Neither of them ever says "you failed", "blocked", or
/// "not allowed" (CONTEXT §3 principle 7).
///
/// Every string is passed in and resolved by the caller through
/// `LocaleController.t(...)`. No sentence is hardcoded here.

class KidLoadingState extends StatelessWidget {
  const KidLoadingState({super.key, this.label});

  final String? label;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: KidSpace.xxl),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          const SparkyMascot(mood: SparkyMood.neutral, size: 64),
          KidSpace.gapLg,
          const CircularProgressIndicator(),
          if (label != null) ...[
            KidSpace.gapLg,
            Text(label!, style: KidText.caption(context), textAlign: TextAlign.center),
          ],
        ],
      ),
    );
  }
}

class KidEmptyState extends StatelessWidget {
  const KidEmptyState({
    super.key,
    required this.title,
    this.body,
    this.actionLabel,
    this.onAction,
    this.mood = SparkyMood.neutral,
  });

  final String title;
  final String? body;
  final String? actionLabel;
  final VoidCallback? onAction;
  final SparkyMood mood;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: KidSpace.xxl, horizontal: KidSpace.lg),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          SparkyMascot(mood: mood, size: 96),
          KidSpace.gapLg,
          Text(title, style: KidText.sectionTitle(context), textAlign: TextAlign.center),
          if (body != null) ...[
            KidSpace.gapSm,
            Text(body!, style: KidText.caption(context), textAlign: TextAlign.center),
          ],
          if (actionLabel != null && onAction != null) ...[
            KidSpace.gapXl,
            KidQuietButton(label: actionLabel!, onPressed: onAction),
          ],
        ],
      ),
    );
  }
}

/// THE CHILD'S ERROR STATE — where `messageAr` finally lands.
///
/// Two visual treatments, one decided by data and not by the screen:
///   * [ApiFailure.isNotNow] (a 409, or one of the named "not right now"
///     codes) → sunshine, Sparky neutral, no alarm. The server's Arabic
///     sentence IS the coaching line: «أكملت هذا البرنامج مرة اليوم —
///     نراك غدًا!».
///   * anything else → coral, Sparky neutral, a gentle "let's try again".
///
/// There is no red, no ✕, and no word for "failed" in either branch.
class KidErrorState extends StatelessWidget {
  const KidErrorState({
    super.key,
    required this.failure,
    required this.title,
    required this.retryLabel,
    this.onRetry,
    this.arabic = true,
    this.compact = false,
  });

  final ApiFailure failure;

  /// The chrome line only. The EXPLANATION comes from the server.
  final String title;
  final String retryLabel;
  final VoidCallback? onRetry;
  final bool arabic;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final notNow = failure.isNotNow;
    final accent = notNow ? KidColor.notNow : KidColor.needsHelp;
    final serverMessage = failure.displayFor(arabic: arabic);

    return Padding(
      padding: EdgeInsets.symmetric(
        vertical: compact ? KidSpace.lg : KidSpace.xxl,
        horizontal: KidSpace.lg,
      ),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          SparkyMascot(mood: SparkyMood.neutral, size: compact ? 64 : 96),
          KidSpace.gapLg,
          Container(
            padding: const EdgeInsets.all(KidSpace.lg),
            decoration: BoxDecoration(
              color: accent.withOpacity(0.14),
              borderRadius: KidRadius.cardBorder,
            ),
            child: Column(
              children: [
                Text(title, style: KidText.sectionTitle(context), textAlign: TextAlign.center),
                KidSpace.gapSm,
                // THE SERVER'S OWN ARABIC SENTENCE. Nothing rewrites it.
                Text(serverMessage, style: KidText.body(context), textAlign: TextAlign.center),
                if (failure.fieldErrors.isNotEmpty) ...[
                  KidSpace.gapSm,
                  ...failure.fieldErrors.map(
                    (e) => Text(
                      e.display,
                      style: KidText.caption(context),
                      textAlign: TextAlign.center,
                    ),
                  ),
                ],
              ],
            ),
          ),
          if (onRetry != null) ...[
            KidSpace.gapXl,
            KidQuietButton(label: retryLabel, icon: Icons.refresh_rounded, onPressed: onRetry),
          ],
        ],
      ),
    );
  }
}

/// Renders a [UiState] through the four widgets above in one call.
class KidStateView<T> extends StatelessWidget {
  const KidStateView({
    super.key,
    required this.state,
    required this.builder,
    required this.emptyTitle,
    required this.errorTitle,
    required this.retryLabel,
    this.emptyBody,
    this.loadingLabel,
    this.onRetry,
    this.arabic = true,
    this.emptyActionLabel,
    this.onEmptyAction,
  });

  final UiState<T> state;
  final Widget Function(BuildContext context, T value) builder;
  final String emptyTitle;
  final String? emptyBody;
  final String errorTitle;
  final String retryLabel;
  final String? loadingLabel;
  final VoidCallback? onRetry;
  final bool arabic;
  final String? emptyActionLabel;
  final VoidCallback? onEmptyAction;

  @override
  Widget build(BuildContext context) {
    return state.when(
      loading: () => KidLoadingState(label: loadingLabel),
      empty: () => KidEmptyState(
        title: emptyTitle,
        body: emptyBody,
        actionLabel: emptyActionLabel,
        onAction: onEmptyAction,
      ),
      error: (failure) => KidErrorState(
        failure: failure,
        title: errorTitle,
        retryLabel: retryLabel,
        onRetry: onRetry,
        arabic: arabic,
      ),
      data: (value) => builder(context, value),
    );
  }
}
