import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/di/providers.dart';
import '../../../core/localization/locale_controller.dart';
import '../../../core/routing/app_routes.dart';
import '../../../core/theme/app_theme.dart';

/// DESIGN PASS: same field-icon and error-card treatment as
/// LoginScreen — consistent visual language across the whole auth flow.
class RegisterScreen extends ConsumerStatefulWidget {
  const RegisterScreen({super.key});

  @override
  ConsumerState<RegisterScreen> createState() => _RegisterScreenState();
}

class _RegisterScreenState extends ConsumerState<RegisterScreen> {
  final _fullNameController = TextEditingController();
  final _emailController = TextEditingController();
  final _passwordController = TextEditingController();
  bool _acceptedTerms = false;
  bool _isSubmitting = false;
  String? _errorMessage;

  Future<void> _submit() async {
    if (!_acceptedTerms) {
      setState(() => _errorMessage = 'Please accept the Terms of Service to continue.');
      return;
    }
    setState(() {
      _isSubmitting = true;
      _errorMessage = null;
    });

    final success = await ref.read(authControllerProvider.notifier).register(
          _fullNameController.text.trim(),
          _emailController.text.trim(),
          _passwordController.text,
          acceptedTerms: _acceptedTerms,
        );

    if (!mounted) return;
    setState(() => _isSubmitting = false);

    if (success) {
      Navigator.of(context).pushNamedAndRemoveUntil(AppRoutes.familySetup, (route) => false);
    } else {
      setState(() => _errorMessage = ref.read(authControllerProvider).errorMessage);
    }
  }

  @override
  Widget build(BuildContext context) {
    ref.watch(localeControllerProvider);
    final t = ref.watch(localeControllerProvider.notifier).t;

    return Scaffold(
      appBar: AppBar(title: Text(t('auth.registerTitle'))),
      body: SafeArea(
        child: SingleChildScrollView(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const SizedBox(height: 8),
                TextField(
                  controller: _fullNameController,
                  decoration: InputDecoration(labelText: t('auth.fullName'), prefixIcon: const Icon(Icons.person_outline_rounded)),
                ),
                const SizedBox(height: 16),
                TextField(
                  controller: _emailController,
                  keyboardType: TextInputType.emailAddress,
                  decoration: InputDecoration(labelText: t('auth.email'), prefixIcon: const Icon(Icons.mail_outline_rounded)),
                ),
                const SizedBox(height: 16),
                TextField(
                  controller: _passwordController,
                  obscureText: true,
                  decoration: InputDecoration(labelText: t('auth.password'), prefixIcon: const Icon(Icons.lock_outline_rounded)),
                ),
                const SizedBox(height: 16),
                // CLOSES A REAL GAP (proactive business/code audit):
                // registration had zero Terms of Service acceptance
                // requirement. HONEST NOTE: this checkbox's text
                // references "Terms of Service" generically — there is
                // no actual Terms of Service document/screen built yet
                // (that requires real legal content this project has
                // consistently declined to invent, same reasoning as
                // never guessing at real subscription pricing).
                CheckboxListTile(
                  contentPadding: EdgeInsets.zero,
                  controlAffinity: ListTileControlAffinity.leading,
                  value: _acceptedTerms,
                  onChanged: (value) => setState(() => _acceptedTerms = value ?? false),
                  title: Text(t('auth.acceptTerms'), style: Theme.of(context).textTheme.bodyMedium),
                ),
                if (_errorMessage != null) ...[
                  const SizedBox(height: 12),
                  Container(
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(color: AppTheme.brick500.withOpacity(0.08), borderRadius: BorderRadius.circular(10)),
                    child: Row(
                      children: [
                        const Icon(Icons.error_outline_rounded, color: AppTheme.brick500, size: 18),
                        const SizedBox(width: 8),
                        Expanded(child: Text(_errorMessage!, style: const TextStyle(color: AppTheme.brick500))),
                      ],
                    ),
                  ),
                ],
                const SizedBox(height: 24),
                FilledButton(
                  onPressed: (_isSubmitting || !_acceptedTerms) ? null : _submit,
                  child: _isSubmitting
                      ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                      : Text(t('auth.register')),
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
    _fullNameController.dispose();
    _emailController.dispose();
    _passwordController.dispose();
    super.dispose();
  }
}
