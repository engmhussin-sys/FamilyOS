import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/di/providers.dart';
import '../../../core/routing/app_routes.dart';
import '../../../core/theme/app_theme.dart';
import '../application/auth_controller.dart';

/// DESIGN PASS: was a bare CircularProgressIndicator on a blank
/// scaffold — the literal first pixel every user of this app has ever
/// seen. Now shows the same brand mark LoginScreen uses, so the
/// transition into the login screen (if unauthenticated) feels
/// continuous rather than a jarring blank-to-branded flash.
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
    if (status == AuthStatus.authenticated) {
      // Best-effort, same reasoning as LoginScreen's own call —
      // an already-logged-in session on app relaunch is exactly as
      // valid a moment to (re-)register the current token.
      ref.read(pushRegistrationServiceProvider).initializeAndRegister();
    }
    Navigator.of(context).pushReplacementNamed(
      status == AuthStatus.authenticated ? AppRoutes.dashboard : AppRoutes.login,
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 80,
              height: 80,
              decoration: BoxDecoration(
                gradient: const LinearGradient(
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                  colors: [AppTheme.guardian950, AppTheme.sage500],
                ),
                borderRadius: BorderRadius.circular(22),
              ),
              child: const Icon(Icons.shield_rounded, color: Colors.white, size: 40),
            ),
            const SizedBox(height: 28),
            const SizedBox(
              width: 24,
              height: 24,
              child: CircularProgressIndicator(strokeWidth: 2.5, color: AppTheme.sage500),
            ),
          ],
        ),
      ),
    );
  }
}
