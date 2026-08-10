import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/di/providers.dart';
import '../../../core/localization/locale_controller.dart';
import '../../../core/network/api_client.dart';
import '../../../core/theme/app_theme.dart';

/// CLOSES A CRITICAL GAP found in a final PM-level review: Sprint B4
/// (Partner Campaigns) built code redemption end-to-end on the
/// admin-dashboard side, but the actual parent using THIS app —
/// the real end user a "telecom distributes a code to its
/// customers" scenario depends on — had no way to redeem anything.
class RedeemCodeScreen extends ConsumerStatefulWidget {
  const RedeemCodeScreen({super.key});

  @override
  ConsumerState<RedeemCodeScreen> createState() => _RedeemCodeScreenState();
}

class _RedeemCodeScreenState extends ConsumerState<RedeemCodeScreen> {
  final _codeController = TextEditingController();
  bool _isSubmitting = false;
  String? _errorMessage;
  String? _successMessage;

  Future<void> _submit() async {
    setState(() {
      _isSubmitting = true;
      _errorMessage = null;
      _successMessage = null;
    });
    try {
      final result = await ref.read(campaignApiProvider).redeemCode(_codeController.text.trim());
      setState(() => _successMessage = result['message'] as String? ?? 'Success!');
      _codeController.clear();
    } on ApiException catch (e) {
      setState(() => _errorMessage = e.message);
    } catch (e) {
      setState(() => _errorMessage = e.toString());
    } finally {
      if (mounted) setState(() => _isSubmitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    ref.watch(localeControllerProvider);
    final t = ref.watch(localeControllerProvider.notifier).t;

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
                if (_successMessage != null) ...[
                  const SizedBox(height: 16),
                  Container(
                    padding: const EdgeInsets.all(16),
                    decoration: BoxDecoration(color: AppTheme.sage500.withOpacity(0.1), borderRadius: BorderRadius.circular(14)),
                    child: Row(
                      children: [
                        const Icon(Icons.check_circle_rounded, color: AppTheme.sage500),
                        const SizedBox(width: 12),
                        Expanded(child: Text(_successMessage!)),
                      ],
                    ),
                  ),
                ],
                if (_errorMessage != null) ...[
                  const SizedBox(height: 16),
                  Container(
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(color: AppTheme.brick500.withOpacity(0.08), borderRadius: BorderRadius.circular(10)),
                    child: Text(_errorMessage!, style: const TextStyle(color: AppTheme.brick500)),
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
