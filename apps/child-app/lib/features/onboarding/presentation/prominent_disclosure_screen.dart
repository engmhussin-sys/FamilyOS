import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design_system/design_system.dart';
import '../../../core/config/app_config.dart';
import '../../../core/di/providers.dart';
import '../../../core/localization/locale_controller.dart';

/// F2 — PROMINENT DISCLOSURE (Google Play User Data policy).
///
/// Audit A3 §4/P2 found this missing from every screen: the app went
/// straight from pairing to Settings deep-links, which is an automatic
/// rejection for an app in this category, and — separately from Play —
/// simply not honest to a family whose child's usage is about to be
/// summarised daily to a server.
///
/// The policy has specific requirements this screen is built to meet:
///   * it appears BEFORE any collection starts and before any sensitive
///     permission is requested (it gates PairingScreen in app.dart);
///   * it is IN THE APP, not only in the privacy policy;
///   * it NAMES the data, concretely — the nine fields listed here are
///     exactly the nine keys `DigitalWellbeingService.buildAndQueueDailySummary`
///     puts on the wire, not a friendly paraphrase of them;
///   * it offers a real, non-punishing way to decline.
///
/// TONE (CONTEXT §3 principle 7). Nothing here is framed as surveillance
/// or as a threat, and declining is not treated as misbehaviour: the
/// decline path says "nothing has been sent" and offers the text again.
class ProminentDisclosureScreen extends ConsumerStatefulWidget {
  const ProminentDisclosureScreen({super.key, required this.onAccepted});

  final VoidCallback onAccepted;

  @override
  ConsumerState<ProminentDisclosureScreen> createState() =>
      _ProminentDisclosureScreenState();
}

class _ProminentDisclosureScreenState
    extends ConsumerState<ProminentDisclosureScreen> {
  bool _declined = false;
  bool _saving = false;

  /// The nine daily-summary fields, in payload order. Kept as a list of
  /// localisation keys so the copy stays in resources (never hard-coded
  /// strings in a widget) and so adding a field to the payload without
  /// adding it here is a visible one-line diff in review.
  static const List<String> _dataKeys = <String>[
    'disclosure.dataUsageDate',
    'disclosure.dataTotalScreenMinutes',
    'disclosure.dataAppBreakdown',
    'disclosure.dataPickupCount',
    'disclosure.dataNightUsageMinutes',
    'disclosure.dataBlockedAttemptCount',
    'disclosure.dataSessionCount',
    'disclosure.dataAverageSessionMinutes',
    'disclosure.dataLongestSessionMinutes',
  ];

  static const List<String> _notCollectedKeys = <String>[
    'disclosure.notCollectedContent',
    'disclosure.notCollectedAudio',
    'disclosure.notCollectedLocation',
  ];

  Future<void> _accept() async {
    setState(() => _saving = true);
    try {
      await ref.read(onboardingConsentStoreProvider).setDisclosureAcknowledged();
    } catch (_) {
      // A failed preferences write must not block the family. Worst case
      // the disclosure is shown again next launch, which is the safe
      // direction to fail in.
    }
    if (mounted) widget.onAccepted();
  }

  @override
  Widget build(BuildContext context) {
    ref.watch(localeControllerProvider);
    final t = ref.watch(localeControllerProvider.notifier).t;

    if (_declined) {
      return Scaffold(
        body: Padding(
          padding: const EdgeInsets.all(KidSpace.xl),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(t('disclosure.declined'), style: KidText.cardTitle(context)),
              const SizedBox(height: KidSpace.xl),
              FilledButton(
                onPressed: () => setState(() => _declined = false),
                child: Text(t('disclosure.declinedAction')),
              ),
            ],
          ),
        ),
      );
    }

    return Scaffold(
      appBar: AppBar(title: Text(t('disclosure.title'))),
      body: SafeArea(
        child: Column(
          children: [
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(20, 16, 20, 8),
                children: [
                  Text(t('disclosure.intro'), style: KidText.body(context)),
                  const SizedBox(height: KidSpace.lg),
                  _sectionTitle(t('disclosure.dataHeading')),
                  ..._dataKeys.map((k) => _bullet(t(k), Icons.arrow_upward_rounded)),
                  const SizedBox(height: KidSpace.lg),
                  _sectionTitle(t('disclosure.notCollectedHeading')),
                  ..._notCollectedKeys.map((k) => _bullet(t(k), Icons.block_rounded)),
                  const SizedBox(height: KidSpace.lg),
                  _bullet(t('disclosure.whoSees'), Icons.family_restroom_rounded),
                  _bullet(t('disclosure.control'), Icons.settings_backup_restore_rounded),
                  // Shown ONLY when a real URL was supplied at build time
                  // (--dart-define=PRIVACY_POLICY_URL). A disclosure that
                  // links to nothing is worse than one that does not link.
                  if (AppConfig.privacyPolicyUrl.isNotEmpty) ...[
                    const SizedBox(height: KidSpace.md),
                    Text(t('disclosure.privacyPolicy'), style: KidText.cardTitle(context)),
                    SelectableText(AppConfig.privacyPolicyUrl),
                  ],
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 8, 20, 16),
              child: Row(
                children: [
                  Expanded(
                    child: TextButton(
                      onPressed: _saving ? null : () => setState(() => _declined = true),
                      child: Text(t('disclosure.decline')),
                    ),
                  ),
                  const SizedBox(width: KidSpace.md),
                  Expanded(
                    flex: 2,
                    child: FilledButton(
                      onPressed: _saving ? null : _accept,
                      child: Text(t('disclosure.accept')),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _sectionTitle(String text) => Padding(
        padding: const EdgeInsets.only(bottom: KidSpace.sm),
        child: Text(text, style: KidText.cardTitle(context).copyWith(fontWeight: FontWeight.w700)),
      );

  Widget _bullet(String text, IconData icon) => Padding(
        padding: const EdgeInsets.only(bottom: KidSpace.md),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.only(top: KidSpace.xs),
              child: Icon(icon, size: 18),
            ),
            const SizedBox(width: KidSpace.md),
            Expanded(child: Text(text, style: KidText.body(context))),
          ],
        ),
      );
}
