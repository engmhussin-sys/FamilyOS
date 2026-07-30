import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/di/providers.dart';
import '../../../core/localization/locale_controller.dart';
import '../../../core/routing/app_routes.dart';

class CreateFamilyScreen extends ConsumerStatefulWidget {
  const CreateFamilyScreen({super.key});

  @override
  ConsumerState<CreateFamilyScreen> createState() => _CreateFamilyScreenState();
}

class _CreateFamilyScreenState extends ConsumerState<CreateFamilyScreen> {
  final _nameController = TextEditingController();
  final _countryController = TextEditingController(); // client-side only — see FamilyApi's docstring
  int _numberOfChildren = 1; // client-side only, an onboarding expectation-setter, not persisted
  bool _isSubmitting = false;
  String? _errorMessage;

  Future<void> _submit() async {
    setState(() {
      _isSubmitting = true;
      _errorMessage = null;
    });

    try {
      await ref.read(familyApiProvider).setupFamily(name: _nameController.text.trim());
      if (!mounted) return;
      Navigator.of(context).pushReplacementNamed(AppRoutes.dashboard);
    } catch (e) {
      setState(() => _errorMessage = e.toString());
    } finally {
      if (mounted) setState(() => _isSubmitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    ref.watch(localeControllerProvider); // registers rebuild dependency — see fix note below
    final t = ref.watch(localeControllerProvider.notifier).t;

    return Scaffold(
      appBar: AppBar(title: Text(t('family.setupTitle'))),
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
                controller: _nameController,
                decoration: InputDecoration(labelText: t('family.name')),
              ),
              const SizedBox(height: 16),
              TextField(
                controller: _countryController,
                decoration: InputDecoration(labelText: t('family.country')),
              ),
              const SizedBox(height: 16),
              Text(t('family.numberOfChildren'), style: Theme.of(context).textTheme.labelLarge),
              Slider(
                value: _numberOfChildren.toDouble(),
                min: 1,
                max: 6,
                divisions: 5,
                label: '$_numberOfChildren',
                onChanged: (value) => setState(() => _numberOfChildren = value.round()),
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
                    : Text(t('family.continueButton')),
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
    _nameController.dispose();
    _countryController.dispose();
    super.dispose();
  }
}
