import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design_system/design_system.dart';
import '../../../core/di/providers.dart';
import '../../../core/errors/api_failure.dart';
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

  /// THE SERVER'S refusal — rendered VERBATIM through
  /// `ApiFailure.displayFor`, Arabic first, never through `t()`.
  ApiFailure? _failure;

  /// A CLIENT-SIDE refusal — this form's own precondition, for which no
  /// request was ever made. A FLAG rather than a message: the sentence is
  /// resolved in `build` through a LITERAL `t('...')` call site, which is the
  /// only shape `scripts/verify_l10n_parity.py` can follow. Keeping this apart
  /// from [_failure] is what stops a server sentence being passed through
  /// `t()` and a client sentence being shipped as the hardcoded English
  /// literal this replaced.
  bool _termsNotAccepted = false;

  Future<void> _submit() async {
    if (!_acceptedTerms) {
      setState(() => _termsNotAccepted = true);
      return;
    }
    setState(() {
      _isSubmitting = true;
      _termsNotAccepted = false;
      _failure = null;
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
      setState(() => _failure = ref.read(authControllerProvider).failure);
    }
  }

  @override
  Widget build(BuildContext context) {
    ref.watch(localeControllerProvider);
    final locale = ref.watch(localeControllerProvider.notifier);
    final t = locale.t;

    // One banner, two possible authors. The client's own sentence wins when
    // present: it means no request was sent, so there is no server sentence to
    // show.
    final String? errorText = _termsNotAccepted
        ? t('auth.acceptTermsRequired')
        : (_failure == null ? null : _failure!.displayFor(arabic: locale.isRtl));

    return Scaffold(
      appBar: AppBar(title: Text(t('auth.registerTitle'))),
      body: SafeArea(
        child: SingleChildScrollView(
          child: Padding(
            padding: const EdgeInsets.all(DsSpace.xl),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const SizedBox(height: DsSpace.sm),
                TextField(
                  controller: _fullNameController,
                  decoration: InputDecoration(labelText: t('auth.fullName'), prefixIcon: const Icon(Icons.person_outline_rounded)),
                ),
                const SizedBox(height: DsSpace.lg),
                TextField(
                  controller: _emailController,
                  keyboardType: TextInputType.emailAddress,
                  decoration: InputDecoration(labelText: t('auth.email'), prefixIcon: const Icon(Icons.mail_outline_rounded)),
                ),
                const SizedBox(height: DsSpace.lg),
                TextField(
                  controller: _passwordController,
                  obscureText: true,
                  decoration: InputDecoration(labelText: t('auth.password'), prefixIcon: const Icon(Icons.lock_outline_rounded)),
                ),
                const SizedBox(height: DsSpace.lg),
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
                // THE SERVER'S OWN SENTENCE, ARABIC FIRST AND VERBATIM.
                // This banner used to render `e.toString()` — «ApiException:
                // Instance of 'DioException'» — which told a parent nothing and
                // threw away the `messageAr` the B3 envelope already carried.
                if (errorText != null) ...[
                  const SizedBox(height: DsSpace.md),
                  Container(
                    padding: const EdgeInsets.all(DsSpace.md),
                    decoration: BoxDecoration(color: AppTheme.brick500.withOpacity(0.08), borderRadius: BorderRadius.circular(DsRadius.control)),
                    child: Row(
                      children: [
                        const Icon(Icons.error_outline_rounded, color: AppTheme.brick500, size: 18),
                        const SizedBox(width: DsSpace.sm),
                        Expanded(
                          child: Text(
                            errorText,
                            style: const TextStyle(color: AppTheme.brick500),
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
                const SizedBox(height: DsSpace.xl),
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
