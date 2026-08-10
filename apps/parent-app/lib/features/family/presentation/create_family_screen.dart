import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/di/providers.dart';
import '../../../core/localization/locale_controller.dart';
import '../../../core/routing/app_routes.dart';
import '../../../core/theme/app_theme.dart';

/// DESIGN PASS: the children-count slider now shows a large live
/// number badge (matching the visual weight the pairing code got on
/// AddChildScreen) instead of a small label above a bare Slider.
class CreateFamilyScreen extends ConsumerStatefulWidget {
  const CreateFamilyScreen({super.key});

  @override
  ConsumerState<CreateFamilyScreen> createState() => _CreateFamilyScreenState();
}

class _CreateFamilyScreenState extends ConsumerState<CreateFamilyScreen> {
  final _nameController = TextEditingController();
  final _countryController = TextEditingController();
  int _numberOfChildren = 1;
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
    ref.watch(localeControllerProvider);
    final t = ref.watch(localeControllerProvider.notifier).t;

    return Scaffold(
      appBar: AppBar(title: Text(t('family.setupTitle'))),
      body: SafeArea(
        child: SingleChildScrollView(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                TextField(
                  controller: _nameController,
                  decoration: InputDecoration(labelText: t('family.name'), prefixIcon: const Icon(Icons.home_rounded)),
                ),
                const SizedBox(height: 16),
                TextField(
                  controller: _countryController,
                  decoration: InputDecoration(labelText: t('family.country'), prefixIcon: const Icon(Icons.public_rounded)),
                ),
                const SizedBox(height: 24),
                Row(
                  children: [
                    Expanded(child: Text(t('family.numberOfChildren'), style: Theme.of(context).textTheme.titleMedium)),
                    Container(
                      width: 36,
                      height: 36,
                      decoration: BoxDecoration(color: AppTheme.sage500.withOpacity(0.14), shape: BoxShape.circle),
                      alignment: Alignment.center,
                      child: Text('$_numberOfChildren', style: Theme.of(context).textTheme.titleMedium?.copyWith(color: AppTheme.sage500, fontWeight: FontWeight.w700)),
                    ),
                  ],
                ),
                SliderTheme(
                  data: SliderTheme.of(context).copyWith(activeTrackColor: AppTheme.sage500, thumbColor: AppTheme.sage500),
                  child: Slider(
                    value: _numberOfChildren.toDouble(),
                    min: 1,
                    max: 6,
                    divisions: 5,
                    label: '$_numberOfChildren',
                    onChanged: (value) => setState(() => _numberOfChildren = value.round()),
                  ),
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
                  onPressed: _isSubmitting ? null : _submit,
                  child: _isSubmitting
                      ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
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
