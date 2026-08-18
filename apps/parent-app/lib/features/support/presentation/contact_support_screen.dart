import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design_system/design_system.dart';
import '../../../core/di/providers.dart';
import '../../../core/errors/api_failure.dart';
import '../../../core/localization/locale_controller.dart';
import '../../../core/theme/app_theme.dart';

/// ERROR PASS: `_errorMessage = e.toString()` is gone.
///
/// This is the worst screen in the app to show raw exception text on. A
/// parent only opens it because something is ALREADY wrong; answering their
/// attempt to report that with «The request returned an invalid status code
/// of 502» hands them a second problem they can do even less about.
///
/// The call now goes through [SupportRepository], which converts and LOGS —
/// so a support request that failed to send leaves a `requestId` in the
/// crash reporter, which is the value support would otherwise have to ask
/// this parent for. The failure renders through the shared `DsErrorState`,
/// titled with the OUTCOME («رسالتك ما اتبعتتش») so there is no ambiguity
/// about whether the message is on its way.
class ContactSupportScreen extends ConsumerStatefulWidget {
  const ContactSupportScreen({super.key});

  @override
  ConsumerState<ContactSupportScreen> createState() => _ContactSupportScreenState();
}

class _ContactSupportScreenState extends ConsumerState<ContactSupportScreen> {
  final _emailController = TextEditingController();
  final _subjectController = TextEditingController();
  final _messageController = TextEditingController();
  bool _isSubmitting = false;
  bool _submitted = false;

  /// The B3 envelope, not `e.toString()`. Its `diagnostic` still holds the
  /// original transport text; no widget on this screen reads that field.
  ApiFailure? _failure;

  @override
  void initState() {
    super.initState();
    // HONEST NOTE: AuthState currently exposes only status/errorMessage,
    // not the logged-in user's own profile — so this cannot pre-fill
    // the email field. The field starts empty; the person types it
    // themselves. A real future improvement once AuthState carries a
    // user profile, not attempted here as a workaround.
  }

  Future<void> _submit() async {
    setState(() {
      _isSubmitting = true;
      _failure = null;
    });
    try {
      await ref.read(supportRepositoryProvider).submitRequest(
            email: _emailController.text.trim(),
            subject: _subjectController.text.trim(),
            message: _messageController.text.trim(),
          );
      if (mounted) setState(() => _submitted = true);
    } catch (error) {
      // The repository throws `ApiFailure` and has already logged the
      // original with its stack.
      if (mounted) setState(() => _failure = ApiFailure.from(error));
    } finally {
      if (mounted) setState(() => _isSubmitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    ref.watch(localeControllerProvider);
    final locale = ref.watch(localeControllerProvider.notifier);
    final t = locale.t;
    final isRtl = locale.isRtl;

    return Scaffold(
      appBar: AppBar(title: Text(t('support.contactTitle'))),
      body: SafeArea(
        child: _submitted
            ? _buildSuccessState(t)
            : SingleChildScrollView(
                child: Padding(
                  padding: const EdgeInsets.all(24),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      TextField(
                        controller: _emailController,
                        keyboardType: TextInputType.emailAddress,
                        decoration: InputDecoration(labelText: t('support.email'), prefixIcon: const Icon(Icons.mail_outline_rounded)),
                      ),
                      const SizedBox(height: 16),
                      TextField(
                        controller: _subjectController,
                        decoration: InputDecoration(labelText: t('support.subject'), prefixIcon: const Icon(Icons.subject_rounded)),
                      ),
                      const SizedBox(height: 16),
                      TextField(
                        controller: _messageController,
                        maxLines: 6,
                        decoration: InputDecoration(labelText: t('support.message'), alignLabelWithHint: true),
                      ),
                      if (_failure != null) ...[
                        const SizedBox(height: 12),
                        DsErrorState(
                          failure: _failure!,
                          title: t('support.sendFailedTitle'),
                          // The Send button below is still there and still
                          // holds the typed message, so this action clears
                          // the banner rather than re-firing the request.
                          retryLabel: t('common.dismiss'),
                          requestIdLabel: t('common.requestId'),
                          arabic: isRtl,
                          compact: true,
                          onRetry: () => setState(() => _failure = null),
                        ),
                      ],
                      const SizedBox(height: 24),
                      FilledButton(
                        onPressed: _isSubmitting ? null : _submit,
                        child: _isSubmitting
                            ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                            : Text(t('support.send')),
                      ),
                    ],
                  ),
                ),
              ),
      ),
    );
  }

  Widget _buildSuccessState(String Function(String, {int? count, Map<String, Object>? options}) t) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.check_circle_rounded, color: AppTheme.sage500, size: 56),
            const SizedBox(height: 16),
            Text(t('support.sentTitle'), style: Theme.of(context).textTheme.titleLarge, textAlign: TextAlign.center),
            const SizedBox(height: 8),
            Text(t('support.sentBody'), textAlign: TextAlign.center),
            const SizedBox(height: 24),
            FilledButton(onPressed: () => Navigator.of(context).pop(), child: Text(t('common.done'))),
          ],
        ),
      ),
    );
  }

  @override
  void dispose() {
    _emailController.dispose();
    _subjectController.dispose();
    _messageController.dispose();
    super.dispose();
  }
}
