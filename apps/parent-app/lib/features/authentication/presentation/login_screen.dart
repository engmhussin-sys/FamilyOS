import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/di/providers.dart';
import '../../../core/errors/api_failure.dart';
import '../../../core/localization/locale_controller.dart';
import '../../../core/routing/app_routes.dart';
import '../../../core/theme/app_theme.dart';

/// DESIGN PASS: the very first screen every parent ever sees was a
/// bare form with a headline and two text fields — no brand identity
/// at all. Now has a real hero section (a guardian-shield mark + a
/// short trust-building tagline) above the form, establishing the
/// "trustworthy, calm" tone the whole app's palette was designed
/// around before the person even logs in.
class LoginScreen extends ConsumerStatefulWidget {
  const LoginScreen({super.key});

  @override
  ConsumerState<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends ConsumerState<LoginScreen> {
  final _emailController = TextEditingController();
  final _passwordController = TextEditingController();
  bool _isSubmitting = false;
  ApiFailure? _failure;

  Future<void> _submit() async {
    setState(() {
      _isSubmitting = true;
      _failure = null;
    });

    final success = await ref
        .read(authControllerProvider.notifier)
        .login(_emailController.text.trim(), _passwordController.text);

    if (!mounted) return;
    setState(() => _isSubmitting = false);

    if (success) {
      // Best-effort, fire-and-forget — never blocks navigation on a
      // push registration outcome (see PushRegistrationService's own
      // docstring for why this can safely fail silently today).
      ref.read(pushRegistrationServiceProvider).initializeAndRegister();
      Navigator.of(context).pushReplacementNamed(AppRoutes.dashboard);
    } else {
      setState(() => _failure = ref.read(authControllerProvider).failure);
    }
  }

  @override
  Widget build(BuildContext context) {
    ref.watch(localeControllerProvider);
    final locale = ref.watch(localeControllerProvider.notifier);
    final t = locale.t;

    return Scaffold(
      body: SafeArea(
        child: SingleChildScrollView(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const SizedBox(height: 24),
                Center(
                  child: Container(
                    width: 72,
                    height: 72,
                    decoration: BoxDecoration(
                      gradient: LinearGradient(
                        begin: Alignment.topLeft,
                        end: Alignment.bottomRight,
                        colors: [AppTheme.guardian950, AppTheme.sage500],
                      ),
                      borderRadius: BorderRadius.circular(20),
                      boxShadow: [BoxShadow(color: AppTheme.guardian950.withOpacity(0.25), blurRadius: 20, offset: const Offset(0, 8))],
                    ),
                    child: const Icon(Icons.shield_rounded, color: Colors.white, size: 36),
                  ),
                ),
                const SizedBox(height: 24),
                Text(t('auth.loginTitle'), style: Theme.of(context).textTheme.displaySmall, textAlign: TextAlign.center),
                const SizedBox(height: 8),
                Text(
                  t('auth.loginTagline'),
                  style: Theme.of(context).textTheme.bodyLarge,
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: 36),
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
                // THE SERVER'S OWN SENTENCE, ARABIC FIRST AND VERBATIM.
                // This banner used to render `e.toString()` — «ApiException:
                // Instance of 'DioException'» — which told a parent nothing and
                // threw away the `messageAr` the B3 envelope already carried.
                if (_failure != null) ...[
                  const SizedBox(height: 12),
                  Container(
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: AppTheme.brick500.withOpacity(0.08),
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: Row(
                      children: [
                        const Icon(Icons.error_outline_rounded, color: AppTheme.brick500, size: 18),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(
                            _failure!.displayFor(arabic: locale.isRtl),
                            style: const TextStyle(color: AppTheme.brick500),
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
                const SizedBox(height: 24),
                FilledButton(
                  onPressed: _isSubmitting ? null : _submit,
                  child: _isSubmitting
                      ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
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
