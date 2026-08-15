import 'package:flutter/material.dart';

import '../errors/api_failure.dart';
import '../state/ui_state.dart';
import 'ds_components.dart';
import 'ds_tokens.dart';

/// THE FOUR STATE WIDGETS.
///
/// Paired one-to-one with [UiState]'s four cases, so "does this screen
/// handle its empty state?" stops being a question a reviewer has to ask
/// file by file.
///
/// EVERY STRING IS PASSED IN. Not one of these widgets contains a literal
/// sentence — the caller resolves it through `LocaleController.t(...)`.
/// That is deliberate: a design-system widget that hardcodes "Something
/// went wrong" is a hardcoded string with extra steps, and this project's
/// own l10n parity script would never catch it.

class DsLoadingState extends StatelessWidget {
  const DsLoadingState({super.key, this.label});

  final String? label;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: DsSpace.xxl),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          const CircularProgressIndicator(),
          if (label != null) ...[
            DsSpace.gapLg,
            Text(label!, style: DsText.caption(context), textAlign: TextAlign.center),
          ],
        ],
      ),
    );
  }
}

class DsEmptyState extends StatelessWidget {
  const DsEmptyState({
    super.key,
    required this.title,
    this.body,
    this.icon = Icons.inbox_outlined,
    this.actionLabel,
    this.onAction,
  });

  final String title;
  final String? body;
  final IconData icon;
  final String? actionLabel;
  final VoidCallback? onAction;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: DsSpace.xxl, horizontal: DsSpace.lg),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(icon, size: 44, color: DsColor.stateMuted),
          DsSpace.gapLg,
          Text(title, style: DsText.sectionTitle(context), textAlign: TextAlign.center),
          if (body != null) ...[
            DsSpace.gapSm,
            Text(body!, style: DsText.caption(context), textAlign: TextAlign.center),
          ],
          if (actionLabel != null && onAction != null) ...[
            DsSpace.gapXl,
            DsPrimaryButton(label: actionLabel!, onPressed: onAction, expand: false),
          ],
        ],
      ),
    );
  }
}

/// THE ERROR STATE THAT FINALLY RENDERS `messageAr`.
///
/// [failure] carries the B3 envelope. The widget shows [ApiFailure.display]
/// — Arabic first, English fallback — and nothing else invents a sentence.
/// [retryLabel] and [title] are the only caller-localised strings, because
/// the SERVER owns the actual explanation and the client owns only the
/// chrome around it.
///
/// `requestId` is rendered small and selectable when present: it is the
/// single value that lets support join this screen to a log line, an outbox
/// row and a Sentry event (B3 §3).
class DsErrorState extends StatelessWidget {
  const DsErrorState({
    super.key,
    required this.failure,
    required this.title,
    required this.retryLabel,
    this.onRetry,
    this.arabic = true,
    this.requestIdLabel,
    this.compact = false,
  });

  final ApiFailure failure;
  final String title;
  final String retryLabel;
  final VoidCallback? onRetry;
  final bool arabic;
  final String? requestIdLabel;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final serverMessage = failure.displayFor(arabic: arabic);
    return Padding(
      padding: EdgeInsets.symmetric(
        vertical: compact ? DsSpace.lg : DsSpace.xxl,
        horizontal: DsSpace.lg,
      ),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(
            failure.isOffline ? Icons.wifi_off_rounded : Icons.error_outline_rounded,
            size: compact ? 32 : 44,
            color: DsColor.stateError,
          ),
          DsSpace.gapMd,
          Text(title, style: DsText.sectionTitle(context), textAlign: TextAlign.center),
          DsSpace.gapSm,
          // THE LINE THIS WHOLE PHASE EXISTS FOR.
          Text(serverMessage, style: DsText.body(context), textAlign: TextAlign.center),
          if (failure.fieldErrors.isNotEmpty) ...[
            DsSpace.gapMd,
            ...failure.fieldErrors.map(
              (e) => Padding(
                padding: const EdgeInsets.only(bottom: DsSpace.xs),
                child: Text(
                  '• ${e.display}',
                  style: DsText.caption(context).copyWith(color: DsColor.stateError),
                  textAlign: TextAlign.center,
                ),
              ),
            ),
          ],
          if (failure.requestId != null && requestIdLabel != null) ...[
            DsSpace.gapSm,
            SelectableText(
              '$requestIdLabel ${failure.requestId}',
              style: DsText.caption(context).copyWith(fontSize: 11),
              textAlign: TextAlign.center,
            ),
          ],
          if (onRetry != null) ...[
            DsSpace.gapXl,
            DsSecondaryButton(
              label: retryLabel,
              icon: Icons.refresh_rounded,
              onPressed: onRetry,
              expand: false,
            ),
          ],
        ],
      ),
    );
  }
}

/// The success acknowledgement — a banner, not a dialog, so it never
/// blocks the next action.
class DsSuccessBanner extends StatelessWidget {
  const DsSuccessBanner({super.key, required this.message, this.onDismiss});

  final String message;
  final VoidCallback? onDismiss;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: DsSpace.md),
      padding: const EdgeInsets.symmetric(horizontal: DsSpace.lg, vertical: DsSpace.md),
      decoration: BoxDecoration(
        color: DsColor.stateSuccess.withOpacity(0.10),
        borderRadius: DsRadius.controlBorder,
        border: Border.all(color: DsColor.stateSuccess.withOpacity(0.3)),
      ),
      child: Row(
        children: [
          const Icon(Icons.check_circle_outline_rounded, color: DsColor.stateSuccess, size: 20),
          DsSpace.hGapMd,
          Expanded(child: Text(message, style: DsText.body(context))),
          if (onDismiss != null)
            IconButton(
              icon: const Icon(Icons.close_rounded, size: 18),
              onPressed: onDismiss,
              visualDensity: VisualDensity.compact,
            ),
        ],
      ),
    );
  }
}

/// Renders a [UiState] through the four widgets above in one call, so a
/// screen body is a single expression and a forgotten branch is a compile
/// error rather than a blank screen.
class DsStateView<T> extends StatelessWidget {
  const DsStateView({
    super.key,
    required this.state,
    required this.builder,
    required this.emptyTitle,
    required this.errorTitle,
    required this.retryLabel,
    this.emptyBody,
    this.emptyIcon = Icons.inbox_outlined,
    this.loadingLabel,
    this.onRetry,
    this.arabic = true,
    this.requestIdLabel,
    this.emptyActionLabel,
    this.onEmptyAction,
  });

  final UiState<T> state;
  final Widget Function(BuildContext context, T value) builder;
  final String emptyTitle;
  final String? emptyBody;
  final IconData emptyIcon;
  final String errorTitle;
  final String retryLabel;
  final String? loadingLabel;
  final VoidCallback? onRetry;
  final bool arabic;
  final String? requestIdLabel;
  final String? emptyActionLabel;
  final VoidCallback? onEmptyAction;

  @override
  Widget build(BuildContext context) {
    return state.when(
      loading: () => DsLoadingState(label: loadingLabel),
      empty: () => DsEmptyState(
        title: emptyTitle,
        body: emptyBody,
        icon: emptyIcon,
        actionLabel: emptyActionLabel,
        onAction: onEmptyAction,
      ),
      error: (failure) => DsErrorState(
        failure: failure,
        title: errorTitle,
        retryLabel: retryLabel,
        onRetry: onRetry,
        arabic: arabic,
        requestIdLabel: requestIdLabel,
      ),
      data: (value) => builder(context, value),
    );
  }
}
