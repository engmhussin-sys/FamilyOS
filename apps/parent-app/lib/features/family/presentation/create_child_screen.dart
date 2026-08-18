import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design_system/design_system.dart';
import '../../../core/di/providers.dart';
import '../../../core/errors/api_failure.dart';
import '../../../core/localization/locale_controller.dart';
import '../../../core/theme/app_theme.dart';

/// CLOSES A FUNDAMENTAL GAP found while wiring Sprint 1's consent
/// enforcement: no screen anywhere in this app ever called
/// `POST /children` — `AddChildScreen` (pairing) always assumed a
/// child profile already existed. This is that missing screen, and
/// — per Sprint 1's Option C — the point where consent is granted
/// explicitly and visibly, not silently.
///
/// ERROR PASS: one `String? _errorMessage` used to hold two unrelated
/// things — this form's own precondition, written as a hardcoded English
/// literal on an Arabic-first screen, and `e.toString()` from the server.
/// They are now separate fields, because they are separate facts: one is
/// something the parent can fix in this form right now, the other is
/// something the server said. The server call goes through
/// [ChildProfileRepository], which converts and LOGS, and its failure
/// renders through the shared `DsErrorState`.
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

  /// THIS FORM'S OWN PRECONDITION, and never the server's. No request is
  /// sent without a date of birth, so there is no `messageAr` to render and
  /// this sentence is the app's to write — as a localisation key, not the
  /// English literal that used to sit here.
  String? _validationMessage;

  /// The B3 envelope, not `e.toString()`. Its `diagnostic` still holds the
  /// original transport text; no widget on this screen reads that field.
  ApiFailure? _failure;

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
      setState(() {
        _validationMessage =
            ref.read(localeControllerProvider.notifier).t('createChild.dateOfBirthRequired');
        _failure = null;
      });
      return;
    }
    setState(() {
      _isSubmitting = true;
      _validationMessage = null;
      _failure = null;
    });

    final repository = ref.read(childProfileRepositoryProvider);
    try {
      // The repository returns the id and throws if the body carried none,
      // so the `child['id'] as String` that used to live here — a
      // `TypeError` waiting on a shape change, rendered to the parent as
      // raw text — is gone from the screen entirely.
      final childId = await repository.createChild(
        firstName: _firstNameController.text.trim(),
        lastName: _lastNameController.text.trim(),
        dateOfBirth: _dateOfBirth!.toIso8601String().split('T').first,
      );

      // Sprint 1 (Option C): grant the baseline consent set right
      // after creation, matching this screen's own explicit copy
      // above the submit button. Best-effort, UNCHANGED: a failure here
      // must not block the parent from having successfully created the
      // child profile — the Manage Consents screen remains available
      // to fix this manually if the call happened to fail. It is no longer
      // silent, though: the repository hands the original error and its
      // stack to the crash reporter on the way past.
      try {
        await repository.grantDefaultConsents(childId);
      } catch (_) {
        // Best-effort, see comment above.
      }

      if (mounted) Navigator.of(context).pop(true);
    } catch (error) {
      // The repository throws `ApiFailure` and has already logged the
      // original with its stack.
      if (mounted) setState(() => _failure = ApiFailure.from(error));
    } finally {
      if (mounted) setState(() => _isSubmitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    ref.watch(localeControllerProvider);
    final locale = ref.watch(localeControllerProvider.notifier);
    final t = locale.t;
    final isRtl = locale.isRtl;

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
                // The form's own precondition keeps the small inline box it
                // has always had: it is one localised sentence about a field
                // on this screen, with no server envelope behind it and
                // nothing to retry.
                if (_validationMessage != null) ...[
                  const SizedBox(height: 12),
                  Container(
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(color: AppTheme.brick500.withOpacity(0.08), borderRadius: BorderRadius.circular(10)),
                    child: Text(_validationMessage!, style: const TextStyle(color: AppTheme.brick500)),
                  ),
                ],
                if (_failure != null) ...[
                  const SizedBox(height: 12),
                  DsErrorState(
                    failure: _failure!,
                    title: t('createChild.saveFailedTitle'),
                    retryLabel: t('common.dismiss'),
                    requestIdLabel: t('common.requestId'),
                    arabic: isRtl,
                    compact: true,
                    onRetry: () => setState(() => _failure = null),
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
