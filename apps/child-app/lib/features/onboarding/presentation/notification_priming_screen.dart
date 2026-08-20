import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design_system/design_system.dart';
import '../../../core/localization/locale_controller.dart';

/// G18 — PRE-PERMISSION PRIMING for POST_NOTIFICATIONS.
///
/// WHY THIS SCREEN EXISTS AT ALL
/// The manifest has declared POST_NOTIFICATIONS since Sprint 4 and nothing in
/// this app ever requested it. On Android 13+ (API 33) that means the platform
/// silently dropped EVERY notification the app posted: the foreground-service
/// notification, RuntimeAlertNotifier's alerts, and the entire output of the
/// Smart Notification Engine. The engine passed all of its tests and would have
/// been invisible on a real device.
///
/// WHY AN EXPLANATION FIRST, RATHER THAN JUST CALLING requestPermissions
/// Android shows the notification dialog AT MOST TWICE in an app's lifetime.
/// After the second decline it never appears again and the only route left is
/// the phone's settings screen. So the dialog is a scarce, non-renewable
/// resource, and spending one on a child who has no idea what is being asked is
/// the one mistake that cannot be undone in-app. This screen is shown
/// immediately before it, and NEVER on cold start — it is reached only from the
/// permission checklist, i.e. after the child (or the parent beside them) has
/// chosen to look at what is missing.
///
/// WHAT THE COPY PROMISES, AND WHY EACH LINE IS TRUE
///   "when you have earned a new reward" — the rewards engine already emits
///   these; see plugins/notifications.
///   "a heads-up before quiet hours begin" — RuntimeWatchdogScheduler's bedtime
///   alarm, which exists.
///   "no adverts, and never a message that tells you off" — CONTEXT §3.7's
///   non-punitive rule, enforced by PG-001 on the backend.
/// If any of those three stops being true, this copy becomes a lie and must
/// change with it. That coupling is the point, exactly as in
/// AccessibilityPrimingScreen.
///
/// Returns `true` from [show] when the child chose to see the system dialog.
class NotificationPrimingScreen extends ConsumerWidget {
  const NotificationPrimingScreen({super.key});

  /// A full-screen route rather than a dialog, matching
  /// AccessibilityPrimingScreen: an explanation the user must act on should not
  /// be dismissible by tapping beside it.
  static Future<bool> show(BuildContext context) async {
    final accepted = await Navigator.of(context).push<bool>(
      MaterialPageRoute(builder: (_) => const NotificationPrimingScreen()),
    );
    return accepted ?? false;
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    ref.watch(localeControllerProvider);
    final t = ref.watch(localeControllerProvider.notifier).t;

    return Scaffold(
      appBar: AppBar(title: Text(t('notifPriming.title'))),
      body: SafeArea(
        child: Column(
          children: [
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(20, 16, 20, 8),
                children: [
                  Text(
                    t('notifPriming.what'),
                    style: KidText.body(context),
                  ),
                  const SizedBox(height: KidSpace.lg),
                  _line(context, t('notifPriming.example1'), Icons.card_giftcard_rounded),
                  _line(context, t('notifPriming.example2'), Icons.nightlight_round),
                  _line(context, t('notifPriming.example3'), Icons.emoji_events_outlined),
                  const SizedBox(height: KidSpace.sm),
                  Text(
                    t('notifPriming.why'),
                    style: KidText.body(context),
                  ),
                  const SizedBox(height: KidSpace.md),
                  Text(
                    t('notifPriming.noSpam'),
                    style: KidText.caption(context),
                  ),
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
                      child: Text(t('notifPriming.later')),
                    ),
                  ),
                  const SizedBox(width: KidSpace.md),
                  Expanded(
                    flex: 2,
                    child: FilledButton(
                      onPressed: () => Navigator.of(context).pop(true),
                      child: Text(t('notifPriming.allow')),
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

  Widget _line(BuildContext context, String text, IconData icon) => Padding(
        padding: const EdgeInsets.only(bottom: KidSpace.md),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(padding: const EdgeInsets.only(top: KidSpace.xs), child: Icon(icon, size: 20)),
            const SizedBox(width: KidSpace.md),
            Expanded(child: Text(text, style: KidText.body(context))),
          ],
        ),
      );
}
