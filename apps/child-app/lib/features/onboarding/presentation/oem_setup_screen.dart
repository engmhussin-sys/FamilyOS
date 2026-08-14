import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/di/providers.dart';
import '../../../core/localization/locale_controller.dart';
import '../application/oem_background_service.dart';

/// F2 — OEM SURVIVAL STEP (audit verdict risk R7).
///
/// Xiaomi/MIUI, Oppo/ColorOS, Vivo, Huawei/EMUI and the Transsion family
/// (Infinix/Tecno — a very large share of the Egyptian market, this
/// product's first) all maintain an autostart allow-list outside AOSP.
/// An app absent from it is killed on screen-off, and `START_STICKY` +
/// WorkManager + BootReceiver do not change that. The failure is silent:
/// the parent sees a healthy device, and nothing is enforced.
///
/// No API can add this app to those lists. All any app can do is open the
/// right screen, explain what to tap, and be honest when it cannot find
/// it — which is what this screen does. `OemBackgroundRestrictionManager`
/// wraps every OEM Intent in try/catch and falls back to the platform
/// battery screen, so a renamed vendor Activity degrades to a slightly
/// worse instruction instead of an `ActivityNotFoundException` crash in
/// the middle of a child's onboarding.
///
/// TONE (CONTEXT §3 principle 7): the copy blames the phone's factory
/// setting, never the child, and never implies they were trying to evade
/// anything. "خلّي الخطة شغّالة", not "منع التحايل".
class OemSetupScreen extends ConsumerStatefulWidget {
  const OemSetupScreen({super.key, this.onFinished});

  /// Called when the step is completed or skipped. Optional so the screen
  /// can also be opened stand-alone from the diagnostics list.
  final VoidCallback? onFinished;

  static Future<void> show(BuildContext context) {
    return Navigator.of(context).push<void>(
      MaterialPageRoute(builder: (_) => const OemSetupScreen()),
    );
  }

  @override
  ConsumerState<OemSetupScreen> createState() => _OemSetupScreenState();
}

class _OemSetupScreenState extends ConsumerState<OemSetupScreen> {
  OemBackgroundInfo? _info;
  String? _openedMessageKey;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final info = await ref.read(oemBackgroundServiceProvider).load();
    if (mounted) setState(() => _info = info);
  }

  Future<void> _open() async {
    final key = await ref.read(oemBackgroundServiceProvider).openSettingsAndDescribe();
    if (mounted) setState(() => _openedMessageKey = key);
  }

  Future<void> _finish() async {
    try {
      await ref.read(onboardingConsentStoreProvider).setOemStepCompleted();
    } catch (_) {
      // Same reasoning as the disclosure store: a failed write means the
      // step is offered again, which is harmless.
    }
    if (!mounted) return;
    widget.onFinished?.call();
    if (Navigator.of(context).canPop()) Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    ref.watch(localeControllerProvider);
    final t = ref.watch(localeControllerProvider.notifier).t;
    final info = _info;

    return Scaffold(
      appBar: AppBar(title: Text(t('oem.title'))),
      body: SafeArea(
        child: Column(
          children: [
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(20, 16, 20, 8),
                children: [
                  Text(t('oem.intro'), style: const TextStyle(fontSize: 16, height: 1.5)),
                  const SizedBox(height: 12),
                  Text(t('oem.reassure'), style: const TextStyle(fontSize: 14)),
                  const SizedBox(height: 20),
                  if (info == null)
                    Text(t('common.checking'), style: const TextStyle(color: Colors.grey))
                  else ...[
                    if (info.manufacturer.isNotEmpty)
                      Text(
                        t('oem.deviceLabel', options: {'manufacturer': info.manufacturer}),
                        style: const TextStyle(fontWeight: FontWeight.bold),
                      ),
                    const SizedBox(height: 12),
                    Text(
                      t('oem.stepsHeading'),
                      style: const TextStyle(fontSize: 17, fontWeight: FontWeight.bold),
                    ),
                    const SizedBox(height: 8),
                    // Vendor-specific instructions, resolved from the
                    // detected manufacturer. An unrecognised device
                    // resolves to `oem.step.generic` inside
                    // OemBackgroundInfo, so this can never miss a key.
                    Text(t(info.stepsKey), style: const TextStyle(fontSize: 15, height: 1.5)),
                  ],
                  if (_openedMessageKey != null) ...[
                    const SizedBox(height: 16),
                    Container(
                      padding: const EdgeInsets.all(12),
                      decoration: BoxDecoration(
                        // withOpacity, NOT withValues: the CI pin is
                        // Flutter 3.24.5 and Color.withValues only exists
                        // from 3.27. See build-apk.yml's env block.
                        color: Colors.amber.withOpacity(0.15),
                        borderRadius: BorderRadius.circular(8),
                      ),
                      child: Text(t(_openedMessageKey!), style: const TextStyle(fontSize: 14)),
                    ),
                  ],
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 8, 20, 16),
              child: Column(
                children: [
                  SizedBox(
                    width: double.infinity,
                    child: FilledButton.icon(
                      onPressed: info == null ? null : _open,
                      icon: const Icon(Icons.open_in_new_rounded),
                      label: Text(t('oem.open')),
                    ),
                  ),
                  const SizedBox(height: 8),
                  Row(
                    children: [
                      Expanded(
                        child: TextButton(
                          onPressed: _finish,
                          child: Text(t('oem.skip')),
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: OutlinedButton(
                          onPressed: _finish,
                          child: Text(t('oem.done')),
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
