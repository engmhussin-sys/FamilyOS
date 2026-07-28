import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'core/di/providers.dart';
import 'core/platform/agent_capability_not_implemented_exception.dart';
import 'core/platform/agent_channel.dart';

/// Deliberately NOT a real feature screen — Decision-009/013's
/// instruction was explicit: no additional UI screens before Steps 2–12
/// of the Core Architecture are complete. This widget exists solely to
/// prove, end-to-end, that Dart can call into native Android and get a
/// real answer back — the one thing every later step depends on.
class ChildAgentApp extends ConsumerWidget {
  const ChildAgentApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return const MaterialApp(
      title: 'AI Family Digital Coach — Agent',
      debugShowCheckedModeBanner: false,
      home: _PlatformChannelDiagnosticScreen(),
    );
  }
}

class _PlatformChannelDiagnosticScreen extends ConsumerWidget {
  const _PlatformChannelDiagnosticScreen();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final channel = ref.watch(agentPlatformChannelProvider);

    return Scaffold(
      appBar: AppBar(title: const Text('Core Architecture — Diagnostic')),
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
                  '✅ Dart ↔ Kotlin channel is working.',
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
