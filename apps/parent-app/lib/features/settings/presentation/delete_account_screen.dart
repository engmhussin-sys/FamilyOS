import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/di/providers.dart';
import '../../../core/localization/locale_controller.dart';
import '../../../core/routing/app_routes.dart';
import '../../../core/theme/app_theme.dart';

/// CLOSES A REAL GAP (proactive business/code audit): the frontend
/// half of AccountDeletionService — the backend mechanism existed
/// with zero way for a parent to actually reach it.
class DeleteAccountScreen extends ConsumerStatefulWidget {
  const DeleteAccountScreen({super.key});

  @override
  ConsumerState<DeleteAccountScreen> createState() => _DeleteAccountScreenState();
}

class _DeleteAccountScreenState extends ConsumerState<DeleteAccountScreen> {
  final _passwordController = TextEditingController();
  bool _hasConfirmedUnderstanding = false;
  bool _isSubmitting = false;
  String? _errorMessage;

  Future<void> _submit() async {
    setState(() {
      _isSubmitting = true;
      _errorMessage = null;
    });
    try {
      await ref.read(accountApiProvider).deleteAccount(_passwordController.text);
      await ref.read(authControllerProvider.notifier).logout();
      if (mounted) {
        Navigator.of(context).pushNamedAndRemoveUntil(AppRoutes.login, (route) => false);
      }
    } catch (e) {
      if (mounted) setState(() => _errorMessage = e.toString());
    } finally {
      if (mounted) setState(() => _isSubmitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    ref.watch(localeControllerProvider);
    final t = ref.watch(localeControllerProvider.notifier).t;

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
                if (_errorMessage != null) ...[
                  const SizedBox(height: 12),
                  Container(
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(color: AppTheme.brick500.withOpacity(0.08), borderRadius: BorderRadius.circular(10)),
                    child: Text(_errorMessage!, style: const TextStyle(color: AppTheme.brick500)),
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
