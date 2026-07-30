import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

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
            padding: const EdgeInsets.symmetric(vertical: 6, horizontal: 12),
            child: SafeArea(
              bottom: false,
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  const Icon(Icons.wifi_off, color: Colors.white, size: 16),
                  const SizedBox(width: 8),
                  Text(
                    t('common.offlineBanner'),
                    style: const TextStyle(color: Colors.white, fontSize: 13),
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
          padding: const EdgeInsets.only(left: 8),
          child: Text('($count)', style: const TextStyle(color: Colors.white, fontSize: 13)),
        );
      },
    );
  }
}
