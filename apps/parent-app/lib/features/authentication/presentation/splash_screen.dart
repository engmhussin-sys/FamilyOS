import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/di/providers.dart';
import '../../../core/routing/app_routes.dart';
import '../application/auth_controller.dart';

class SplashScreen extends ConsumerStatefulWidget {
  const SplashScreen({super.key});

  @override
  ConsumerState<SplashScreen> createState() => _SplashScreenState();
}

class _SplashScreenState extends ConsumerState<SplashScreen> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _checkSessionAndNavigate());
  }

  Future<void> _checkSessionAndNavigate() async {
    await ref.read(authControllerProvider.notifier).checkSession();
    if (!mounted) return;

    final status = ref.read(authControllerProvider).status;
    Navigator.of(context).pushReplacementNamed(
      status == AuthStatus.authenticated ? AppRoutes.dashboard : AppRoutes.login,
    );
  }

  @override
  Widget build(BuildContext context) {
    return const Scaffold(
      body: Center(child: CircularProgressIndicator()),
    );
  }
}
