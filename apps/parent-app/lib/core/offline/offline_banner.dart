import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../design_system/design_system.dart';
import '../connectivity/connectivity_controller.dart';
import '../di/providers.dart';
import '../localization/locale_controller.dart';

/// The explicit "clear banner: no connection" requirement from the
/// review. Placed once in `main.dart` (wrapping every screen), not
/// duplicated per-screen.
class OfflineBanner extends ConsumerWidget {
  const OfflineBanner({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final isOnline = ref.watch(connectivityControllerProvider);
    ref.watch(localeControllerProvider);
    final t = ref.watch(localeControllerProvider.notifier).t;

    return Column(
      children: [
        if (!isOnline)
          Container(
            width: double.infinity,
            color: Theme.of(context).colorScheme.error,
            padding: const EdgeInsets.symmetric(vertical: DsSpace.sm, horizontal: DsSpace.md),
            child: SafeArea(
              bottom: false,
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  const Icon(Icons.wifi_off, color: DsColor.onDark, size: DsIconSize.sm),
                  DsSpace.hGapSm,
                  Text(
                    t('common.offlineBanner'),
                    // Was `TextStyle(color: Colors.white, fontSize: 13)` —
                    // a size that exists nowhere in the scale and carried
                    // no line height, on the one piece of chrome that can
                    // appear above any screen in the app.
                    style: DsText.caption(context).copyWith(color: DsColor.onDark),
                  ),
                  const _PendingOperationsBadge(),
                ],
              ),
            ),
          ),
        Expanded(child: child),
      ],
    );
  }
}

class _PendingOperationsBadge extends ConsumerWidget {
  const _PendingOperationsBadge();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return FutureBuilder<int>(
      future: ref.watch(pendingOperationsQueueProvider).length(),
      builder: (context, snapshot) {
        final count = snapshot.data ?? 0;
        if (count == 0) return const SizedBox.shrink();
        return Padding(
          // Was an absolute `EdgeInsets.only(left:)` inset, which put the
          // count on the WRONG side of the label in Arabic — this
          // product's default language.
          padding: const EdgeInsetsDirectional.only(start: DsSpace.sm),
          child: Text('($count)', style: DsText.caption(context).copyWith(color: DsColor.onDark)),
        );
      },
    );
  }
}
