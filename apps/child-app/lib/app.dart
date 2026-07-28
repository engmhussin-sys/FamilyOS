import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'core/di/providers.dart';
import 'core/platform/agent_capability_not_implemented_exception.dart';
import 'core/platform/agent_channel.dart';
import 'features/pairing/presentation/pairing_screen.dart';

/// Sprint 3 update: routes between the pairing onboarding screen (no
/// stored session) and a paired-status screen (session exists) —
/// still exactly the "onboarding/diagnostic screens only" scope this
/// project has held to since Step 1; no feature UI beyond that line.
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
    return const _PlatformChannelDiagnosticScreen();
  }
}

/// Retained from Step 1 as the paired-state landing screen — now also
/// serves as visible proof the platform channel (including Sprint 3's
/// new `getDevicePublicKey`) is wired, post-pairing.
class _PlatformChannelDiagnosticScreen extends ConsumerWidget {
  const _PlatformChannelDiagnosticScreen();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final channel = ref.watch(agentPlatformChannelProvider);

    return Scaffold(
      appBar: AppBar(title: const Text('Device Status')),
      body: Padding(
        padding: const EdgeInsets.all(24),
        child: FutureBuilder<_Diagnostics>(
          future: _loadDiagnostics(channel),
          builder: (context, snapshot) {
            if (snapshot.connectionState != ConnectionState.done) {
              return const Center(child: CircularProgressIndicator());
            }
            if (snapshot.hasError) {
              final error = snapshot.error;
              final isNotImplemented = error is AgentCapabilityNotImplementedException;
              return Text(
                isNotImplemented
                    ? 'Platform channel is wired, but native handler for '
                        '"${error.methodName}" is missing — check MainActivity.kt.'
                    : 'Platform channel call failed: $error',
                style: const TextStyle(color: Colors.red),
              );
            }
            final diagnostics = snapshot.data!;
            return Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  '✅ Device paired. Heartbeat running.',
                  style: TextStyle(fontWeight: FontWeight.bold),
                ),
                const SizedBox(height: 12),
                Text('Native app version: ${diagnostics.appVersion}'),
                Text('Android SDK level: ${diagnostics.sdkInt}'),
              ],
            );
          },
        ),
      ),
    );
  }

  Future<_Diagnostics> _loadDiagnostics(AgentPlatformChannel channel) async {
    final version = await channel.getNativeAppVersion();
    final sdkInt = await channel.getAndroidSdkInt();
    return _Diagnostics(appVersion: version, sdkInt: sdkInt);
  }
}

class _Diagnostics {
  const _Diagnostics({required this.appVersion, required this.sdkInt});
  final String appVersion;
  final int sdkInt;
}
