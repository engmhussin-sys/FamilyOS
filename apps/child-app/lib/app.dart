import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'core/di/providers.dart';
import 'features/pairing/presentation/pairing_screen.dart';
import 'features/device_status/presentation/device_home_screen.dart';

/// Sprint 4 update: the paired-state landing screen is now
/// DeviceHomeScreen (permission checklist + capability sync), replacing
/// Step 1's bare platform-channel diagnostic screen — still within the
/// standing "onboarding/diagnostic screens only" scope, since
/// DeviceHomeScreen IS the onboarding/diagnostic screen for a paired
/// device, not a new feature surface.
class ChildAgentApp extends ConsumerWidget {
  const ChildAgentApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return const MaterialApp(
      title: 'AI Family Digital Coach — Agent',
      debugShowCheckedModeBanner: false,
      home: _AppRoot(),
    );
  }
}

class _AppRoot extends ConsumerStatefulWidget {
  const _AppRoot();

  @override
  ConsumerState<_AppRoot> createState() => _AppRootState();
}

class _AppRootState extends ConsumerState<_AppRoot> {
  bool? _isPaired;

  @override
  void initState() {
    super.initState();
    _checkSession();
  }

  Future<void> _checkSession() async {
    final tokenStorage = ref.read(tokenStorageProvider);
    final hasSession = await tokenStorage.hasSession();
    if (mounted) setState(() => _isPaired = hasSession);
    if (hasSession) {
      ref.read(heartbeatServiceProvider).start();
    }
  }

  void _onPaired() {
    setState(() => _isPaired = true);
    ref.read(heartbeatServiceProvider).start();
  }

  @override
  Widget build(BuildContext context) {
    if (_isPaired == null) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    if (_isPaired == false) {
      return PairingScreen(onPaired: _onPaired);
    }
    return const DeviceHomeScreen();
  }
}
