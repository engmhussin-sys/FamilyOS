import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/di/providers.dart';
import '../../../core/localization/locale_controller.dart';
import '../../../core/routing/app_routes.dart';
import '../../../core/theme/app_theme.dart';
import '../api/family_api.dart';

/// WHAT CHANGED, AND WHY IT WAS NOT COSMETIC.
///
/// 1. COUNTRY IS NOW A CHOICE, NOT FREE TEXT. It was a `TextField`, so
///    "مصر", "Egypt", "egypt " and a typo all arrived as different
///    strings — and none of them could be turned into an IANA timezone.
///    It is now a two-item picker over [supportedFamilyCountries], which
///    is the only shape that can resolve to `Africa/Cairo` /
///    `Asia/Riyadh` deterministically.
/// 2. THE TIMEZONE IS ACTUALLY SENT. The country's zone goes out on the
///    same `PATCH /settings` call as the name. Before, it never did, and
///    `Family.timezone` stayed on its schema default of `"UTC"` for the
///    life of the family — which moves every business-day boundary the
///    backend computes (streaks, daily limits, reward idempotency keys).
///    The resolved zone is shown on screen rather than hidden, because a
///    setting this consequential should not be invisible at the moment
///    it is chosen.
/// 3. THE "NUMBER OF CHILDREN" SLIDER IS GONE. It went nowhere:
///    `UpdateSettingsDto` has no such field, `model Family` has no such
///    column, and child count is derived from real `Child` rows created
///    later on the create-child screen. A control that implies it is
///    saving something and saves nothing is worse than no control, so it
///    was removed rather than annotated as decorative.
class CreateFamilyScreen extends ConsumerStatefulWidget {
  const CreateFamilyScreen({super.key});

  @override
  ConsumerState<CreateFamilyScreen> createState() => _CreateFamilyScreenState();
}

class _CreateFamilyScreenState extends ConsumerState<CreateFamilyScreen> {
  final _nameController = TextEditingController();

  /// Defaults to Egypt — the larger launch market — rather than to `null`,
  /// so the common case is one tap and the request can never go out
  /// without a timezone by accident.
  String _countryCode = supportedFamilyCountries.first;

  bool _isSubmitting = false;
  String? _errorMessage;

  Future<void> _submit() async {
    setState(() {
      _isSubmitting = true;
      _errorMessage = null;
    });

    try {
      await ref.read(familyApiProvider).setupFamily(
            name: _nameController.text.trim(),
            countryCode: _countryCode,
          );
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

    // Resolved through LITERAL `t('...')` keys on purpose: a key built by
    // string interpolation is invisible to `scripts/verify_l10n_parity.py`,
    // which only follows literal call sites. Keeping the two in a map means
    // the checker still proves both labels exist in both locales.
    final countryLabels = <String, String>{
      'EG': t('family.country.EG'),
      'SA': t('family.country.SA'),
    };

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
                DropdownButtonFormField<String>(
                  value: _countryCode,
                  decoration: InputDecoration(labelText: t('family.country'), prefixIcon: const Icon(Icons.public_rounded)),
                  items: supportedFamilyCountries
                      .map((code) => DropdownMenuItem(value: code, child: Text(countryLabels[code] ?? code)))
                      .toList(),
                  onChanged: _isSubmitting
                      ? null
                      : (value) => setState(() => _countryCode = value ?? _countryCode),
                ),
                const SizedBox(height: 12),
                // The zone is stated in words, not as a raw IANA string: a
                // parent should not have to know what "Africa/Cairo" means
                // to understand that their day starts at midnight Cairo
                // time. `t()` supplies the sentence; the country supplies
                // the noun.
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Icon(Icons.schedule_rounded, size: 18, color: AppTheme.sage500),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        t('family.timezoneExplainer', options: {'country': countryLabels[_countryCode] ?? _countryCode}),
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                    ),
                  ],
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
    super.dispose();
  }
}
