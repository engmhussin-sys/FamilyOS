import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design_system/design_system.dart';
import '../../../core/di/providers.dart';
import '../../../core/errors/api_failure.dart';
import '../../../core/localization/locale_controller.dart';
import '../../../core/theme/app_theme.dart';

/// CLOSES A CRITICAL GAP found in a final PM-level review: Sprint B4
/// (Partner Campaigns) built code redemption end-to-end on the
/// admin-dashboard side, but the actual parent using THIS app —
/// the real end user a "telecom distributes a code to its
/// customers" scenario depends on — had no way to redeem anything.
///
/// ERROR PASS: this screen had BOTH shapes of the same bug —
/// `on ApiException catch (e) { e.message }`, which is the transport's
/// English including its status code, and `catch (e) { e.toString() }`,
/// which is a developer artefact. Both went straight into a red box.
///
/// A CODE IS SPENT ONCE, so the fix is not just "show a nicer sentence".
/// The two failures mean opposite things to a parent holding a code:
///   * the server refused it (`ApiFailure.isServerRefusal`) — this code is
///     no good, and «الكود ده مش مقبول» tells them to stop retyping it;
///   * the server never decided (offline, timeout, 5xx) or the throttle
///     answered — the code is untouched, and «الكود لسه ما اتستخدمش»
///     tells them the SAME code is still the right thing to try.
/// Collapsing those two into one message would be a clearer sentence that
/// leads to a worse decision. The server's own explanation renders under
/// either title.
class RedeemCodeScreen extends ConsumerStatefulWidget {
  const RedeemCodeScreen({super.key});

  @override
  ConsumerState<RedeemCodeScreen> createState() => _RedeemCodeScreenState();
}

class _RedeemCodeScreenState extends ConsumerState<RedeemCodeScreen> {
  final _codeController = TextEditingController();
  bool _isSubmitting = false;

  /// The B3 envelope, not `e.message`. Its `diagnostic` still carries the
  /// original transport text for the log; nothing on this screen renders it.
  ApiFailure? _failure;

  /// WHETHER A REDEMPTION SUCCEEDED, kept separately from what the server
  /// SAID about it. They used to be one nullable string, so "applied, and
  /// the server described nothing" and "not applied" were the same state —
  /// which is why the old code needed `?? 'Success!'` to avoid rendering a
  /// blank success box, and why that English literal existed at all.
  bool _redeemed = false;

  /// SERVER-AUTHORED, AND THEREFORE VERBATIM. `CampaignRedemptionService`
  /// builds this sentence with the real numbers in it ("extended by 14
  /// day(s), now ending 2026-09-01"); no client can reproduce that, so it is
  /// shown exactly as sent. `null` only when the server described nothing.
  String? _successMessage;

  Future<void> _submit() async {
    setState(() {
      _isSubmitting = true;
      _failure = null;
      _redeemed = false;
      _successMessage = null;
    });
    try {
      final result = await ref
          .read(campaignRepositoryProvider)
          .redeemCode(_codeController.text.trim());
      if (mounted) {
        setState(() {
          _redeemed = true;
          _successMessage = result.message;
        });
        _codeController.clear();
      }
    } catch (error) {
      // The repository throws `ApiFailure` and has already logged the
      // original with its stack.
      if (mounted) setState(() => _failure = ApiFailure.from(error));
    } finally {
      if (mounted) setState(() => _isSubmitting = false);
    }
  }

  /// TRUE only when the SERVER looked at this code and said no.
  ///
  /// A 429 is deliberately excluded: the throttle on this endpoint is the
  /// tightest in the whole API (5/min, because a bare code string is the one
  /// real brute-force target here) and it fires on the parent's SECOND
  /// attempt with a perfectly valid code. Telling them the code is invalid
  /// because they typed it twice would send them looking for a new one they
  /// do not need.
  bool get _codeWasRejected {
    final failure = _failure;
    return failure != null && failure.isServerRefusal && !failure.isRateLimited;
  }

  /// The server's sentence when there is one, a localised line when there is
  /// not. Never an English literal, and never empty — a blank success box is
  /// indistinguishable from a bug.
  String _successLine(
    String Function(String, {int? count, Map<String, Object>? options}) t,
  ) {
    final message = _successMessage;
    if (message == null || message.trim().isEmpty) {
      return t('redeemCode.successFallback');
    }
    return message;
  }

  @override
  Widget build(BuildContext context) {
    ref.watch(localeControllerProvider);
    final locale = ref.watch(localeControllerProvider.notifier);
    final t = locale.t;
    final isRtl = locale.isRtl;

    return Scaffold(
      appBar: AppBar(title: Text(t('redeemCode.title'))),
      body: SafeArea(
        child: SingleChildScrollView(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Icon(Icons.confirmation_number_outlined, size: 48, color: AppTheme.sage500),
                const SizedBox(height: 16),
                Text(t('redeemCode.explanation'), style: Theme.of(context).textTheme.bodyMedium, textAlign: TextAlign.center),
                const SizedBox(height: 24),
                TextField(
                  controller: _codeController,
                  textCapitalization: TextCapitalization.characters,
                  onChanged: (_) => setState(() {}),
                  decoration: InputDecoration(labelText: t('redeemCode.codeLabel'), prefixIcon: const Icon(Icons.qr_code_rounded)),
                ),
                if (_redeemed) ...[
                  const SizedBox(height: 16),
                  Container(
                    padding: const EdgeInsets.all(16),
                    decoration: BoxDecoration(color: AppTheme.sage500.withOpacity(0.1), borderRadius: BorderRadius.circular(14)),
                    child: Row(
                      children: [
                        const Icon(Icons.check_circle_rounded, color: AppTheme.sage500),
                        const SizedBox(width: 12),
                        // The server's own sentence, or — only when it sent
                        // none — a localised line. It used to be
                        // `?? 'Success!'`, an English literal on an
                        // Arabic-first screen.
                        Expanded(child: Text(_successLine(t))),
                      ],
                    ),
                  ),
                ],
                if (_failure != null) ...[
                  const SizedBox(height: 16),
                  DsErrorState(
                    failure: _failure!,
                    title: _codeWasRejected
                        ? t('redeemCode.rejectedTitle')
                        : t('redeemCode.notAppliedTitle'),
                    retryLabel: t('common.dismiss'),
                    requestIdLabel: t('common.requestId'),
                    arabic: isRtl,
                    compact: true,
                    onRetry: () => setState(() => _failure = null),
                  ),
                ],
                const SizedBox(height: 24),
                FilledButton(
                  onPressed: (_isSubmitting || _codeController.text.trim().isEmpty) ? null : _submit,
                  child: _isSubmitting
                      ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                      : Text(t('redeemCode.submit')),
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
    _codeController.dispose();
    super.dispose();
  }
}
