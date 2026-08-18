import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design_system/design_system.dart';
import '../../../core/di/providers.dart';
import '../../../core/errors/api_failure.dart';
import '../../../core/localization/locale_controller.dart';
import '../../../core/routing/app_routes.dart';
import '../../../core/theme/app_theme.dart';

/// CLOSES A REAL GAP (proactive business/code audit): the frontend
/// half of AccountDeletionService — the backend mechanism existed
/// with zero way for a parent to actually reach it.
///
/// ERROR PASS: `_errorMessage = e.toString()` is gone. On the most
/// destructive screen in the app it put the transport's own English —
/// «The request returned an invalid status code of 502» — in a red box
/// under the password field, at the exact moment a parent needs to know
/// one thing only: is my family's data still there.
///
/// The call goes through [AccountRepository], which converts and LOGS, and
/// the failure renders through the shared `DsErrorState`. The TITLE is
/// chosen from `ApiFailure.isServerRefusal`, because a refusal and a
/// silence are different facts and only one of them licenses the sentence
/// «لم يتم حذف حسابك». Nothing here ever reads as a success: the screen
/// only navigates away after the delete call returns normally.
class DeleteAccountScreen extends ConsumerStatefulWidget {
  const DeleteAccountScreen({super.key});

  @override
  ConsumerState<DeleteAccountScreen> createState() => _DeleteAccountScreenState();
}

class _DeleteAccountScreenState extends ConsumerState<DeleteAccountScreen> {
  final _passwordController = TextEditingController();
  bool _hasConfirmedUnderstanding = false;
  bool _isSubmitting = false;

  /// The B3 envelope, not `e.toString()`. Its `diagnostic` still holds the
  /// original transport text; no widget on this screen reads that field.
  ApiFailure? _failure;

  Future<void> _submit() async {
    setState(() {
      _isSubmitting = true;
      _failure = null;
    });

    // THE DELETE CALL STANDS ALONE, AND THAT IS THE POINT.
    //
    // It used to share a `try` with `logout()` and the navigation. A
    // failure in either of those — a secure-storage write that throws on
    // one OEM, for instance — was caught by the same `catch` and rendered
    // as a deletion error, telling a parent whose account HAD been deleted
    // that it had not been. Splitting them means only the delete call can
    // produce `_failure`.
    try {
      await ref.read(accountRepositoryProvider).deleteAccount(_passwordController.text);
    } catch (error) {
      // The repository throws `ApiFailure` and has already handed the
      // original, with its stack, to the crash reporter. `ApiFailure.from`
      // is idempotent on one, so this covers anything thrown outside that
      // boundary too.
      if (mounted) {
        setState(() {
          _failure = ApiFailure.from(error);
          _isSubmitting = false;
        });
      }
      return;
    }

    // PAST THIS LINE THE ACCOUNT IS GONE. Everything below is local
    // cleanup, and a failure in it is not a failed deletion — every token
    // this device holds now refers to an account that no longer exists.
    try {
      await ref.read(authControllerProvider.notifier).logout();
    } catch (_) {
      // Deliberately swallowed, see above. The unconditional push below
      // leaves the app on the login route either way.
    }
    if (!mounted) return;
    // `_isSubmitting` is deliberately NOT reset: this route is removed by
    // the call below, so the only thing resetting it could do is rebuild a
    // screen on its way out with an enabled Delete button on it.
    Navigator.of(context).pushNamedAndRemoveUntil(AppRoutes.login, (route) => false);
  }

  @override
  Widget build(BuildContext context) {
    ref.watch(localeControllerProvider);
    final locale = ref.watch(localeControllerProvider.notifier);
    final t = locale.t;
    final isRtl = locale.isRtl;

    return Scaffold(
      appBar: AppBar(title: Text(t('deleteAccount.title'))),
      body: SafeArea(
        child: SingleChildScrollView(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Container(
                  padding: const EdgeInsets.all(16),
                  decoration: BoxDecoration(color: AppTheme.brick500.withOpacity(0.08), borderRadius: BorderRadius.circular(14)),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          const Icon(Icons.warning_amber_rounded, color: AppTheme.brick500),
                          const SizedBox(width: 8),
                          Text(t('deleteAccount.warningTitle'), style: Theme.of(context).textTheme.titleMedium?.copyWith(color: AppTheme.brick500)),
                        ],
                      ),
                      const SizedBox(height: 8),
                      Text(t('deleteAccount.warningBody'), style: Theme.of(context).textTheme.bodyMedium),
                    ],
                  ),
                ),
                const SizedBox(height: 24),
                CheckboxListTile(
                  contentPadding: EdgeInsets.zero,
                  controlAffinity: ListTileControlAffinity.leading,
                  value: _hasConfirmedUnderstanding,
                  onChanged: (value) => setState(() => _hasConfirmedUnderstanding = value ?? false),
                  title: Text(t('deleteAccount.confirmCheckbox')),
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: _passwordController,
                  obscureText: true,
                  enabled: _hasConfirmedUnderstanding,
                  onChanged: (_) => setState(() {}),
                  decoration: InputDecoration(labelText: t('deleteAccount.currentPassword'), prefixIcon: const Icon(Icons.lock_outline_rounded)),
                ),
                if (_failure != null) ...[
                  const SizedBox(height: 12),
                  DsErrorState(
                    failure: _failure!,
                    // A REFUSAL IS A FACT; A SILENCE IS NOT.
                    title: _failure!.isServerRefusal
                        ? t('deleteAccount.errorRefusedTitle')
                        : t('deleteAccount.errorUnconfirmedTitle'),
                    // Dismiss, never "Retry": re-firing a permanent deletion
                    // from an error state is not a recovery action. The
                    // Delete button below is still the only way to submit,
                    // and it still needs the checkbox and the password.
                    retryLabel: t('common.dismiss'),
                    requestIdLabel: t('common.requestId'),
                    arabic: isRtl,
                    compact: true,
                    onRetry: () => setState(() => _failure = null),
                  ),
                ],
                const SizedBox(height: 24),
                FilledButton(
                  onPressed: (_hasConfirmedUnderstanding && !_isSubmitting && _passwordController.text.isNotEmpty) ? _submit : null,
                  style: FilledButton.styleFrom(backgroundColor: AppTheme.brick500),
                  child: _isSubmitting
                      ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                      : Text(t('deleteAccount.submit')),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  @override
  void dispose() {
    _passwordController.dispose();
    super.dispose();
  }
}
