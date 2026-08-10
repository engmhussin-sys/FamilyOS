import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/di/providers.dart';
import '../../../core/localization/locale_controller.dart';
import '../../../core/theme/app_theme.dart';

/// CLOSES A FUNDAMENTAL GAP found while wiring Sprint 1's consent
/// enforcement: no screen anywhere in this app ever called
/// `POST /children` — `AddChildScreen` (pairing) always assumed a
/// child profile already existed. This is that missing screen, and
/// — per Sprint 1's Option C — the point where consent is granted
/// explicitly and visibly, not silently.
class CreateChildScreen extends ConsumerStatefulWidget {
  const CreateChildScreen({super.key});

  @override
  ConsumerState<CreateChildScreen> createState() => _CreateChildScreenState();
}

class _CreateChildScreenState extends ConsumerState<CreateChildScreen> {
  final _firstNameController = TextEditingController();
  final _lastNameController = TextEditingController();
  DateTime? _dateOfBirth;
  bool _isSubmitting = false;
  String? _errorMessage;

  Future<void> _pickDateOfBirth() async {
    final now = DateTime.now();
    final picked = await showDatePicker(
      context: context,
      initialDate: DateTime(now.year - 8),
      firstDate: DateTime(now.year - 18),
      lastDate: now,
    );
    if (picked != null) setState(() => _dateOfBirth = picked);
  }

  Future<void> _submit() async {
    if (_dateOfBirth == null) {
      setState(() => _errorMessage = 'Please select a date of birth.');
      return;
    }
    setState(() {
      _isSubmitting = true;
      _errorMessage = null;
    });

    try {
      final dashboardApi = ref.read(dashboardApiProvider);
      final child = await dashboardApi.createChild(
        firstName: _firstNameController.text.trim(),
        lastName: _lastNameController.text.trim(),
        dateOfBirth: _dateOfBirth!.toIso8601String().split('T').first,
      );

      // Sprint 1 (Option C): grant the baseline consent set right
      // after creation, matching this screen's own explicit copy
      // above the submit button. Best-effort: a failure here should
      // not block the parent from having successfully created the
      // child profile — the Manage Consents screen remains available
      // to fix this manually if the call happened to fail.
      try {
        await ref.read(pairingApiProvider).grantDefaultConsents(child['id'] as String);
      } catch (_) {
        // Best-effort, see comment above.
      }

      if (mounted) Navigator.of(context).pop(true);
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
      appBar: AppBar(title: Text(t('createChild.title'))),
      body: SafeArea(
        child: SingleChildScrollView(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                TextField(
                  controller: _firstNameController,
                  decoration: InputDecoration(labelText: t('createChild.firstName'), prefixIcon: const Icon(Icons.person_outline_rounded)),
                ),
                const SizedBox(height: 16),
                TextField(
                  controller: _lastNameController,
                  decoration: InputDecoration(labelText: t('createChild.lastNameOptional')),
                ),
                const SizedBox(height: 16),
                InkWell(
                  onTap: _pickDateOfBirth,
                  child: InputDecorator(
                    decoration: InputDecoration(labelText: t('createChild.dateOfBirth'), prefixIcon: const Icon(Icons.cake_outlined)),
                    child: Text(
                      _dateOfBirth == null
                          ? t('createChild.selectDate')
                          : '${_dateOfBirth!.year}-${_dateOfBirth!.month.toString().padLeft(2, '0')}-${_dateOfBirth!.day.toString().padLeft(2, '0')}',
                    ),
                  ),
                ),
                const SizedBox(height: 24),
                // Sprint 1 (Option C): the explicit consent copy —
                // continuing past this screen means the baseline
                // consent types below are granted, individually
                // revocable later via Settings > Manage Consents.
                Container(
                  padding: const EdgeInsets.all(16),
                  decoration: BoxDecoration(color: AppTheme.sage500.withOpacity(0.08), borderRadius: BorderRadius.circular(14)),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          const Icon(Icons.shield_outlined, size: 18, color: AppTheme.sage500),
                          const SizedBox(width: 8),
                          Text(t('createChild.consentTitle'), style: Theme.of(context).textTheme.titleMedium),
                        ],
                      ),
                      const SizedBox(height: 8),
                      Text(t('createChild.consentBody'), style: Theme.of(context).textTheme.bodyMedium),
                    ],
                  ),
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
                  onPressed: _isSubmitting ? null : _submit,
                  child: _isSubmitting
                      ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                      : Text(t('createChild.submit')),
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
    _firstNameController.dispose();
    _lastNameController.dispose();
    super.dispose();
  }
}
