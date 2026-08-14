import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/localization/locale_controller.dart';

/// F2 — PRE-PERMISSION PRIMING for the AccessibilityService
/// (Google Play policy; audit A3 §4/P1 and P2, verdict risk R5).
///
/// Shown IMMEDIATELY BEFORE the system Accessibility screen, every time
/// the app sends the user there. Before F2 the app deep-linked straight
/// into Settings from the permission checklist, which:
///   * gives a Play reviewer nothing to look at except a raw system
///     dialog, on an app that has already declared
///     `isAccessibilityTool="false"` and is therefore going to manual
///     review by design (F1's deliberate, honest choice); and
///   * asks a family to grant the single most powerful permission on
///     Android with no explanation of what it does.
///
/// WHAT THIS SCREEN PROMISES, AND WHY EACH LINE IS TRUE
///   "reads the name of the app in the foreground" — the service
///   subscribes to `typeWindowStateChanged` only.
///   "cannot read what is on screen" — `canRetrieveWindowContent="false"`
///   in accessibility_service_config.xml, so this is enforced by the
///   platform, not by our good intentions.
/// If either of those declarations ever changes, this copy becomes a lie
/// and must change with it. That coupling is the point.
///
/// Returns `true` from [show] when the user chose to continue to Settings.
class AccessibilityPrimingScreen extends ConsumerWidget {
  const AccessibilityPrimingScreen({super.key});

  /// Presented as a full-screen route rather than a dialog: Play's
  /// guidance for a prominent in-app statement is an interstitial the
  /// user must act on, and a dismissible dialog is not that.
  static Future<bool> show(BuildContext context) async {
    final accepted = await Navigator.of(context).push<bool>(
      MaterialPageRoute(builder: (_) => const AccessibilityPrimingScreen()),
    );
    return accepted ?? false;
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    ref.watch(localeControllerProvider);
    final t = ref.watch(localeControllerProvider.notifier).t;

    return Scaffold(
      appBar: AppBar(title: Text(t('priming.title'))),
      body: SafeArea(
        child: Column(
          children: [
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(20, 16, 20, 8),
                children: [
                  Text(t('priming.what'), style: const TextStyle(fontSize: 16, height: 1.5)),
                  const SizedBox(height: 18),
                  _line(t('priming.reads'), Icons.visibility_outlined),
                  _line(t('priming.doesNotRead'), Icons.lock_outline_rounded),
                  _line(t('priming.why'), Icons.schedule_rounded),
                  const SizedBox(height: 18),
                  Text(
                    t('priming.stepsHeading'),
                    style: const TextStyle(fontSize: 17, fontWeight: FontWeight.bold),
                  ),
                  const SizedBox(height: 8),
                  _step('1', t('priming.step1')),
                  _step('2', t('priming.step2')),
                  _step('3', t('priming.step3')),
                  const SizedBox(height: 12),
                  Text(t('priming.reversible'), style: const TextStyle(fontSize: 14)),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 8, 20, 16),
              child: Row(
                children: [
                  Expanded(
                    child: TextButton(
                      onPressed: () => Navigator.of(context).pop(false),
                      child: Text(t('priming.later')),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    flex: 2,
                    child: FilledButton(
                      onPressed: () => Navigator.of(context).pop(true),
                      child: Text(t('priming.open')),
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

  Widget _line(String text, IconData icon) => Padding(
        padding: const EdgeInsets.only(bottom: 12),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(padding: const EdgeInsets.only(top: 2), child: Icon(icon, size: 20)),
            const SizedBox(width: 10),
            Expanded(child: Text(text, style: const TextStyle(fontSize: 15, height: 1.4))),
          ],
        ),
      );

  Widget _step(String number, String text) => Padding(
        padding: const EdgeInsets.only(bottom: 8),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            CircleAvatar(radius: 12, child: Text(number, style: const TextStyle(fontSize: 12))),
            const SizedBox(width: 10),
            Expanded(child: Text(text, style: const TextStyle(fontSize: 15, height: 1.4))),
          ],
        ),
      );
}
