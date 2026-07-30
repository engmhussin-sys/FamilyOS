import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/di/providers.dart';
import '../../../core/localization/locale_controller.dart';
import '../../../core/routing/app_routes.dart';

class LoginScreen extends ConsumerStatefulWidget {
  const LoginScreen({super.key});

  @override
  ConsumerState<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends ConsumerState<LoginScreen> {
  final _emailController = TextEditingController();
  final _passwordController = TextEditingController();
  bool _isSubmitting = false;
  String? _errorMessage;

  Future<void> _submit() async {
    setState(() {
      _isSubmitting = true;
      _errorMessage = null;
    });

    final success = await ref
        .read(authControllerProvider.notifier)
        .login(_emailController.text.trim(), _passwordController.text);

    if (!mounted) return;
    setState(() => _isSubmitting = false);

    if (success) {
      Navigator.of(context).pushReplacementNamed(AppRoutes.dashboard);
    } else {
      setState(() => _errorMessage = ref.read(authControllerProvider).errorMessage);
    }
  }

  @override
  Widget build(BuildContext context) {
    ref.watch(localeControllerProvider); // registers rebuild dependency — see fix note below
    final t = ref.watch(localeControllerProvider.notifier).t;

    return Scaffold(
      body: SafeArea(
        // PRODUCTION READINESS REVIEW FIX (UI/UX Review — Responsive Layout):
        // this form had no scroll view. On a small device with the
        // keyboard open, the fields + button could exceed the available
        // height and throw a RenderFlex overflow error instead of
        // scrolling — a real, common Flutter form bug.
        child: SingleChildScrollView(
          child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(t('auth.loginTitle'), style: Theme.of(context).textTheme.headlineMedium, textAlign: TextAlign.center),
              const SizedBox(height: 32),
              TextField(
                controller: _emailController,
                keyboardType: TextInputType.emailAddress,
                decoration: InputDecoration(labelText: t('auth.email')),
              ),
              const SizedBox(height: 16),
              TextField(
                controller: _passwordController,
                obscureText: true,
                decoration: InputDecoration(labelText: t('auth.password')),
              ),
              if (_errorMessage != null) ...[
                const SizedBox(height: 12),
                Text(_errorMessage!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
              ],
              const SizedBox(height: 24),
              FilledButton(
                onPressed: _isSubmitting ? null : _submit,
                child: _isSubmitting
                    ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2))
                    : Text(t('auth.login')),
              ),
              const SizedBox(height: 16),
              TextButton(
                onPressed: () => Navigator.of(context).pushNamed(AppRoutes.register),
                child: Text('${t('auth.noAccount')} ${t('auth.createAccount')}'),
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
    _emailController.dispose();
    _passwordController.dispose();
    super.dispose();
  }
}
