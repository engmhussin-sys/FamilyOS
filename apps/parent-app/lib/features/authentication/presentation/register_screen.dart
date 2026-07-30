import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/di/providers.dart';
import '../../../core/localization/locale_controller.dart';
import '../../../core/routing/app_routes.dart';

class RegisterScreen extends ConsumerStatefulWidget {
  const RegisterScreen({super.key});

  @override
  ConsumerState<RegisterScreen> createState() => _RegisterScreenState();
}

class _RegisterScreenState extends ConsumerState<RegisterScreen> {
  final _fullNameController = TextEditingController();
  final _emailController = TextEditingController();
  final _passwordController = TextEditingController();
  bool _isSubmitting = false;
  String? _errorMessage;

  Future<void> _submit() async {
    setState(() {
      _isSubmitting = true;
      _errorMessage = null;
    });

    final success = await ref.read(authControllerProvider.notifier).register(
          _fullNameController.text.trim(),
          _emailController.text.trim(),
          _passwordController.text,
        );

    if (!mounted) return;
    setState(() => _isSubmitting = false);

    if (success) {
      // Family setup, not straight to Dashboard — matches the requested
      // flow (Register -> Create Family -> Dashboard). The backend
      // already created a default Family row during register(); this
      // screen fills in the real name.
      //
      // PRODUCTION READINESS REVIEW FIX (Navigation Review): was
      // `pushReplacementNamed`, which only replaces the TOP of the
      // stack. Login->Register used `push` (not replace), so the stack
      // here is [Login, Register] — a plain replace would leave
      // [Login, FamilySetup], and FamilySetup's own later replace-to-
      // Dashboard would leave [Login, Dashboard]: pressing back on
      // Dashboard would incorrectly return a freshly-registered user to
      // the Login screen. `pushNamedAndRemoveUntil(..., (route) =>
      // false)` clears the ENTIRE stack instead.
      Navigator.of(context).pushNamedAndRemoveUntil(AppRoutes.familySetup, (route) => false);
    } else {
      setState(() => _errorMessage = ref.read(authControllerProvider).errorMessage);
    }
  }

  @override
  Widget build(BuildContext context) {
    ref.watch(localeControllerProvider); // registers rebuild dependency — see fix note below
    final t = ref.watch(localeControllerProvider.notifier).t;

    return Scaffold(
      appBar: AppBar(title: Text(t('auth.registerTitle'))),
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
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              TextField(
                controller: _fullNameController,
                decoration: InputDecoration(labelText: t('auth.fullName')),
              ),
              const SizedBox(height: 16),
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
